/**
 * POST /api/esign/[provider]/webhook  (E-166)
 *
 * Result callback for an NBFC's OWN e-sign provider (their own Digio account,
 * Leegality, …). The provider's adapter parses the raw event into the canonical
 * status; the SHARED forward-only state machine applies it to nbfc_loan_agreements.
 * The signed-PDF fetch (when storage is opted in) uses the NBFC's own credentials.
 *
 * Public — matched by the opaque agreement_ref / provider document id. Always
 * 200-ish so the provider doesn't retry forever.
 */
import { NextRequest, NextResponse } from "next/server";

import { applyAgreementWebhookEvent } from "@/lib/nbfc/agreement-webhook";
import { getEsignProvider, isKnownEsignProvider } from "@/lib/nbfc/esign/registry";
import { loadProviderCredentials } from "@/lib/nbfc/esign/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isKnownEsignProvider(provider)) {
    return NextResponse.json({ ok: false, error: "unknown provider" }, { status: 404 });
  }

  let rawText = "";
  try {
    rawText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const adapter = await getEsignProvider(provider);
  const parsed = await adapter.parseWebhookStatus(rawText, headers);
  if (!parsed || (!parsed.matchRef && !parsed.providerDocumentId)) {
    return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });
  }

  const result = await applyAgreementWebhookEvent(parsed, async (row) => {
    const creds = await loadProviderCredentials(row.tenant_id, row.provider_type ?? provider);
    if (!creds) return { signedPdfUrl: null, auditTrailUrl: null };
    return adapter.fetchSignedDocuments(
      { leadId: row.lead_id, providerDocumentId: row.digio_document_id ?? parsed.providerDocumentId ?? "" },
      creds,
    );
  });

  if (!result.matched) {
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
