/**
 * POST /api/digio/webhook/loan-agreement
 *
 * BRD Addendum §17 — Digio webhook for the NBFC LOAN-AGREEMENT e-sign, for
 * iTarang's GLOBAL Digio account (NBFCs on their OWN Digio keys, or other
 * providers, post to /api/esign/[provider]/webhook instead). Since E-166 this is
 * a thin wrapper: the Digio adapter parses the event and the SHARED forward-only
 * state machine applies it, so there is one code path for all providers.
 *
 * Public — Digio cannot carry a session cookie; matched by the opaque
 * agreement_ref (AGR_<ref>) then the eSign document id. Always returns a stable
 * 200-ish status so Digio doesn't retry forever.
 */
import { NextRequest, NextResponse } from "next/server";

import { DigioEsignAdapter } from "@/lib/nbfc/esign/adapters/digio-adapter";
import { applyAgreementWebhookEvent } from "@/lib/nbfc/agreement-webhook";
import { fetchSignedLoanAgreementPdfAndAuditTrail } from "@/lib/nbfc/fetchSignedAgreementPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let rawText = "";
  try {
    rawText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const adapter = new DigioEsignAdapter();
  const parsed = await adapter.parseWebhookStatus(rawText, {});
  if (!parsed || (!parsed.matchRef && !parsed.providerDocumentId)) {
    return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });
  }

  // Global Digio account → no creds override needed for the signed-PDF fetch.
  const result = await applyAgreementWebhookEvent(parsed, async (row) =>
    fetchSignedLoanAgreementPdfAndAuditTrail({
      leadId: row.lead_id,
      digioDocumentId: row.digio_document_id ?? parsed.providerDocumentId ?? "",
    }),
  );

  if (!result.matched) {
    // 200 so Digio doesn't retry endlessly; logged inside the state machine.
    return NextResponse.json({ ok: true, idempotent: true, reason: result.reason });
  }
  return NextResponse.json({
    ok: true,
    agreement_ref: result.agreementRef,
    status: result.status,
    idempotent: result.idempotent ?? false,
    stored_pdf: result.storedPdf ?? false,
  });
}
