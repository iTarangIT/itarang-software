/**
 * POST /api/nbfc/acquire/[leadId]/verify-doc/action  (multipart/form-data)
 *
 * The NBFC records its per-document decision from the Acquire "KYC verifications"
 * table — Approve / Reject / Request correction — with an optional note and
 * supporting file uploads (any type). Upserts the NBFC's OWN verdict
 * (nbfc_document_verifications, separate from the admin's) with the attachments;
 * the whole thing surfaces to the admin in the KYC review "NBFC Actions" section.
 *
 * Fields: doc_for (primary|co_borrower), doc_key, verdict (verified|rejected|
 *         queried), notes?, files[] (0–5, ≤15 MB each).
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import {
  upsertNbfcVerdict,
  type NbfcVerdict,
  type VerdictAttachment,
} from "@/lib/nbfc/doc-verdict";
import { notifyNbfcDocVerdict } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB per file
const MAX_FILES = 5;
const VALID_VERDICTS = new Set<NbfcVerdict>(["verified", "rejected", "queried"]);

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot verify documents` },
        { status: 403 },
      );
    }
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" },
        { status: 400 },
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: expected multipart/form-data" },
        { status: 400 },
      );
    }

    const docFor = String(form.get("doc_for") ?? "primary") === "co_borrower"
      ? "co_borrower"
      : "primary";
    const docKey = String(form.get("doc_key") ?? "").trim();
    const verdict = String(form.get("verdict") ?? "") as NbfcVerdict;
    const notes = form.get("notes") ? String(form.get("notes")).trim() : null;

    if (!docKey) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: doc_key is required" },
        { status: 400 },
      );
    }
    if (!VALID_VERDICTS.has(verdict)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: verdict must be verified, rejected or queried" },
        { status: 400 },
      );
    }

    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: at most ${MAX_FILES} files per action` },
        { status: 400 },
      );
    }

    const attachments: VerdictAttachment[] = [];
    for (const file of files) {
      if (file.size === 0) continue;
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { ok: false, error: `BAD_REQUEST: '${file.name}' exceeds the 15 MB limit` },
          { status: 400 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const key = `verdict-attachments/${leadId}/${Date.now()}-${safeName(file.name)}`;
      const { url } = await putNbfcObject(
        key,
        buffer,
        file.type || "application/octet-stream",
        { upsert: true },
      );
      attachments.push({
        url,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
      });
    }

    await upsertNbfcVerdict({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      docFor,
      docKey,
      verdict,
      notes,
      attachments,
      verifiedBy: actor.user_id,
    });

    // The admin owns the relationship with the dealer, so an NBFC verdict on a
    // document is theirs to act on. Previously it only appeared if someone
    // happened to open the lead's NBFC Actions section.
    await notifyNbfcDocVerdict({
      leadId,
      nbfcName: await tenantDisplayName(actor.tenant_id),
      docLabel: docFor === "co_borrower" ? `${docKey} (co-borrower)` : docKey,
      verdict,
      comments: notes,
    });

    return NextResponse.json({ ok: true, verdict, attachments });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
