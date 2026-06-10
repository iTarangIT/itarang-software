/**
 * POST /api/nbfc/agreement/[leadId]/upload — BRD Addendum V0.3.1 §17.
 *
 * The NBFC uploads the UNSIGNED loan-agreement PDF for the winning lead. We
 * store it in the private `nbfc-documents` bucket and stamp the URL onto a
 * `pending` nbfc_loan_agreements row; /initiate then hands it to iTarang eSign
 * for the customer (+ NBFC signatory) to sign.
 *
 * Role: operations or nbfc_admin (same as /initiate). PDF only, ≤ 15 MB.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { generateAgreementRef, getLatestAgreement, type AgreementMethod } from "@/lib/nbfc/agreement";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function isPdf(buf: Buffer): boolean {
  // %PDF- magic header — file.type is client-supplied and untrustworthy.
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot upload the agreement; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    const winner = await getWinningAssignment(leadId);
    if (!winner) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no winning NBFC selected for this lead yet" }, { status: 400 });
    }
    if (winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: lead's winning NBFC is a different tenant" }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: expected multipart/form-data body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: file field is required" }, { status: 422 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `BAD_REQUEST: file exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (!isPdf(buf)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: only PDF files are accepted" }, { status: 415 });
    }

    // Guard: don't replace the source once signing is in flight / done.
    const latest = await getLatestAgreement(leadId, winner.nbfc_id);
    if (latest && (latest.status === "in_progress" || latest.status === "signed")) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: an agreement is already in progress or signed — cannot replace the source PDF" },
        { status: 400 },
      );
    }

    // Resolve mechanism + storage opt-in: per-lead snapshot first (§3.4), then live config.
    const snap = (winner.snapshot ?? {}) as {
      doc_agreement_method?: AgreementMethod | null;
      store_sanction_letter?: boolean;
      store_loan_agreement?: boolean;
    };
    let method: AgreementMethod | null = snap.doc_agreement_method ?? null;
    let storeSanction = snap.store_sanction_letter ?? false;
    let storeLoan = snap.store_loan_agreement ?? false;
    if (!method) {
      const [cfg] = await db
        .select({
          m: nbfcServiceConfig.doc_agreement_method,
          s: nbfcServiceConfig.store_sanction_letter,
          l: nbfcServiceConfig.store_loan_agreement,
        })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      method = (cfg?.m ?? "digio") as AgreementMethod | null;
      storeSanction = cfg?.s ?? false;
      storeLoan = cfg?.l ?? false;
    }

    const now = new Date();
    const key = `agreements/${leadId}/source-${now.getTime()}.pdf`;
    const { url: sourceUrl } = await putNbfcObject(key, buf, "application/pdf");

    let agreementId: string;
    if (latest && latest.status === "pending") {
      await db
        .update(nbfcLoanAgreements)
        .set({ source_document_url: sourceUrl, method: method ?? latest.method, updated_at: now })
        .where(eq(nbfcLoanAgreements.id, latest.id));
      agreementId = latest.id;
    } else {
      const [created] = await db
        .insert(nbfcLoanAgreements)
        .values({
          lead_id: leadId,
          nbfc_id: winner.nbfc_id,
          tenant_id: actor.tenant_id,
          agreement_ref: generateAgreementRef(leadId),
          method: method ?? "digio",
          status: "pending",
          source_document_url: sourceUrl,
          provider_raw_status: "source_uploaded",
          store_sanction_letter: storeSanction,
          store_loan_agreement: storeLoan,
          initiated_by: actor.user_id,
          updated_at: now,
        })
        .returning({ id: nbfcLoanAgreements.id });
      agreementId = created.id;
    }

    return NextResponse.json({ ok: true, agreement_id: agreementId, source_document_url: sourceUrl, size: file.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
