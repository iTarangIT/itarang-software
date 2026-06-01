/**
 * POST /api/digio/webhook/loan-agreement
 *
 * BRD Addendum V0.2 §11 — Digio webhook for the NBFC LOAN-AGREEMENT e-sign
 * (distinct from the dealer flow and the NBFC LSP-agreement flow). The
 * create_sign_request set an `AGR_<agreement_ref>` callback; Digio echoes it
 * here on status changes. We match the nbfc_loan_agreements row by that ref.
 *
 * Idempotent forward-only state machine, mirroring /api/digio/webhook/nbfc:
 *   - on COMPLETED  → status 'signed'. The signed PDF + audit trail are stored
 *     ONLY when the NBFC opted into storage (§11.4, store_loan_agreement). When
 *     opted out we keep the §11.6 audit record (loan-exists flag, no PDF).
 *   - on FAILED / EXPIRED → status 'failed'.
 *
 * Auth: public — Digio cannot carry a session cookie; matched by the opaque
 * agreement_ref. Always returns a stable status so Digio doesn't retry forever.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements } from "@/lib/db/schema";
import { fetchSignedLoanAgreementPdfAndAuditTrail } from "@/lib/nbfc/fetchSignedAgreementPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGR_CALLBACK_RE = /^AGR_(.+)$/;

// Forward-only ordering so replays/older events can't regress state.
const STATUS_ORDER: Record<string, number> = {
  SENT_TO_EXTERNAL_PARTY: 1,
  SIGN_PENDING: 2,
  PARTIALLY_SIGNED: 3,
  SIGNED: 6,
  COMPLETED: 7,
  FAILED: 7,
  EXPIRED: 7,
};

const CANONICAL_ORDER: Record<string, number> = {
  pending: 0,
  in_progress: 2,
  signed: 7,
  failed: 7,
  skipped: 7,
};

const WebhookBody = z.object({
  payload: z.object({
    agreement_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    agreement_status: z.enum([
      "SENT_TO_EXTERNAL_PARTY",
      "SIGN_PENDING",
      "PARTIALLY_SIGNED",
      "SIGNED",
      "COMPLETED",
      "FAILED",
      "EXPIRED",
    ]),
    // Optional: uploadpdf does not reliably echo our AGR_<ref> callback, so we
    // fall back to matching on the eSign document id (agreement_id / id).
    callback: z.string().optional(),
    signed_document_url: z.string().url().optional(),
    audit_trail_url: z.string().url().optional(),
  }),
});

export async function POST(req: NextRequest) {
  let bodyJson: unknown = {};
  try {
    const text = await req.text();
    bodyJson = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WebhookBody.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });
  }

  const { payload } = parsed.data;

  // Match by the AGR_<ref> callback when present; otherwise fall back to the
  // eSign document id (uploadpdf doesn't reliably echo our callback).
  let row: typeof nbfcLoanAgreements.$inferSelect | undefined;
  let ref = payload.callback?.match(AGR_CALLBACK_RE)?.[1] ?? "";
  if (ref) {
    [row] = await db.select().from(nbfcLoanAgreements).where(eq(nbfcLoanAgreements.agreement_ref, ref)).limit(1);
  }
  if (!row) {
    const docId = payload.agreement_id || payload.id;
    if (docId) {
      [row] = await db.select().from(nbfcLoanAgreements).where(eq(nbfcLoanAgreements.digio_document_id, docId)).limit(1);
    }
  }
  if (!row) {
    // 200 so Digio doesn't retry endlessly; log for triage.
    console.warn("[Digio loan-agreement webhook] No agreement match", {
      callback: payload.callback,
      docId: payload.agreement_id ?? payload.id,
    });
    return NextResponse.json({ ok: true, idempotent: true, reason: "no matching agreement" });
  }
  ref = row.agreement_ref;

  // Idempotency — never regress.
  const curOrd = CANONICAL_ORDER[String(row.status ?? "")] ?? -1;
  const incOrd = STATUS_ORDER[payload.agreement_status] ?? -1;
  if (curOrd >= 7 || incOrd <= curOrd) {
    const existing = (row.provider_raw_payload as Record<string, unknown>) ?? {};
    await db
      .update(nbfcLoanAgreements)
      .set({
        provider_raw_payload: { ...existing, last_event: payload, idempotent_replay: true },
        updated_at: new Date(),
      })
      .where(eq(nbfcLoanAgreements.id, row.id));
    return NextResponse.json({ ok: true, idempotent: true, status: row.status });
  }

  const now = new Date();
  const terminalGood = payload.agreement_status === "COMPLETED" || payload.agreement_status === "SIGNED";
  const terminalBad = payload.agreement_status === "FAILED" || payload.agreement_status === "EXPIRED";
  const nextStatus = terminalGood ? "signed" : terminalBad ? "failed" : "in_progress";

  const existing = (row.provider_raw_payload as Record<string, unknown>) ?? {};
  const updates: Partial<typeof nbfcLoanAgreements.$inferInsert> = {
    status: nextStatus,
    provider_raw_status: payload.agreement_status,
    provider_raw_payload: { ...existing, last_event: payload },
    updated_at: now,
  };

  if (nextStatus === "signed") {
    updates.signed_at = now;
    // §17.4 — store the signed PDF + audit trail ONLY when the NBFC opted in.
    // Proactively fetch+cache from the eSign provider so the Download buttons
    // work immediately (uploadpdf webhooks often omit the URLs); fall back to
    // any URLs the webhook did carry. Never fail the webhook on a fetch error.
    if (row.store_loan_agreement && row.digio_document_id) {
      try {
        const fetched = await fetchSignedLoanAgreementPdfAndAuditTrail({
          leadId: row.lead_id,
          digioDocumentId: row.digio_document_id,
        });
        updates.signed_document_url = payload.signed_document_url ?? fetched.signedPdfUrl ?? null;
        updates.audit_trail_url = payload.audit_trail_url ?? fetched.auditTrailUrl ?? null;
      } catch (err) {
        console.warn("[Digio loan-agreement webhook] signed PDF fetch failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        if (payload.signed_document_url) updates.signed_document_url = payload.signed_document_url;
        if (payload.audit_trail_url) updates.audit_trail_url = payload.audit_trail_url;
      }
    }
    // When opted out, URLs stay null — the §17.6 audit record (this row:
    // loan-exists flag, signed_at, no PDF) is iTarang's retention. The download
    // proxies still fetch live on demand.
  }
  if (nextStatus === "failed") {
    updates.failure_reason = `Digio reported ${payload.agreement_status}`;
  }

  await db.update(nbfcLoanAgreements).set(updates).where(eq(nbfcLoanAgreements.id, row.id));

  return NextResponse.json({
    ok: true,
    agreement_ref: ref,
    status: nextStatus,
    stored_pdf: nextStatus === "signed" && !!row.store_loan_agreement && !!updates.signed_document_url,
  });
}
