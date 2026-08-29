/**
 * GET/POST /api/nbfc/acquire/[leadId]/verify-doc
 *
 * The NBFC's OWN per-document KYC verdict (Change 1) — separate from the admin's
 * verification. Upsert one row per (assignment, doc_for, doc_key).
 *   GET  → all verdicts this tenant has recorded for the lead.
 *   POST → upsert a verdict { doc_for, doc_key, verdict, notes }.
 *
 * Role: credit_underwriting | nbfc_admin (any seat that reviews the dossier).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcDocumentVerifications } from "@/lib/db/schema";
import { upsertNbfcVerdict } from "@/lib/nbfc/doc-verdict";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z.object({
  doc_for: z.enum(["primary", "co_borrower"]).default("primary"),
  doc_key: z.string().min(1).max(120),
  verdict: z.enum(["pending", "verified", "queried", "rejected"]),
  notes: z.string().max(4000).optional().nullable(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this tenant" },
        { status: 400 },
      );
    }
    const rows = await db
      .select()
      .from(nbfcDocumentVerifications)
      .where(eq(nbfcDocumentVerifications.assignment_id, assignment.id));
    return NextResponse.json({ ok: true, verdicts: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const d = parsed.data;

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

    // One shared write (E-254): upsertNbfcVerdict is also where the leg-1 SLA
    // clock is armed on a queried/rejected verdict, so every verdict path must
    // go through it.
    await upsertNbfcVerdict({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      docFor: d.doc_for,
      docKey: d.doc_key,
      verdict: d.verdict,
      notes: d.notes ?? null,
      verifiedBy: actor.user_id,
    });

    return NextResponse.json({ ok: true, verdict: d.verdict });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
