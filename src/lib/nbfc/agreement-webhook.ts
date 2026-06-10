/**
 * Shared, provider-agnostic loan-agreement webhook state machine (E-166).
 *
 * Both the legacy Digio webhook (/api/digio/webhook/loan-agreement) and the new
 * per-provider route (/api/esign/[provider]/webhook) feed a `ParsedWebhookStatus`
 * here, so there is ONE forward-only canonical state machine. Ordering is on the
 * canonical status (provider-neutral): pending < in_progress < {signed|failed}.
 * §17.4 — the signed PDF + audit trail are stored ONLY when the NBFC opted in
 * (store_loan_agreement); the fetch is delegated to the caller (provider+creds).
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements } from "@/lib/db/schema";
import type { FetchSignedResult, ParsedWebhookStatus } from "./esign/provider";

type AgreementRow = typeof nbfcLoanAgreements.$inferSelect;

const CANONICAL_ORDER: Record<string, number> = {
  pending: 0,
  in_progress: 2,
  signed: 7,
  failed: 7,
  skipped: 7,
};

export interface AgreementWebhookResult {
  matched: boolean;
  idempotent?: boolean;
  status?: string;
  agreementRef?: string;
  storedPdf?: boolean;
  reason?: string;
}

/**
 * Match the agreement (by ref, then provider doc-id), then apply the canonical
 * event forward-only. `fetchSigned` is called on the signed transition only when
 * storage is opted in; it never fails the webhook.
 */
export async function applyAgreementWebhookEvent(
  parsed: ParsedWebhookStatus,
  fetchSigned: (row: AgreementRow) => Promise<FetchSignedResult>,
): Promise<AgreementWebhookResult> {
  let row: AgreementRow | undefined;
  if (parsed.matchRef) {
    [row] = await db
      .select()
      .from(nbfcLoanAgreements)
      .where(eq(nbfcLoanAgreements.agreement_ref, parsed.matchRef))
      .limit(1);
  }
  if (!row && parsed.providerDocumentId) {
    [row] = await db
      .select()
      .from(nbfcLoanAgreements)
      .where(eq(nbfcLoanAgreements.digio_document_id, parsed.providerDocumentId))
      .limit(1);
  }
  if (!row) {
    console.warn("[agreement webhook] no matching agreement", {
      ref: parsed.matchRef,
      docId: parsed.providerDocumentId,
    });
    return { matched: false, reason: "no matching agreement" };
  }

  const existing = (row.provider_raw_payload as Record<string, unknown>) ?? {};
  const curOrd = CANONICAL_ORDER[String(row.status ?? "")] ?? -1;
  const incOrd = CANONICAL_ORDER[parsed.canonical] ?? -1;

  // Terminal already, or a strictly-older event → record + no state change.
  if (curOrd >= 7 || incOrd < curOrd) {
    await db
      .update(nbfcLoanAgreements)
      .set({
        provider_raw_payload: { ...existing, last_event: parsed.raw, idempotent_replay: true },
        updated_at: new Date(),
      })
      .where(eq(nbfcLoanAgreements.id, row.id));
    return { matched: true, idempotent: true, status: row.status ?? undefined, agreementRef: row.agreement_ref };
  }

  const now = new Date();
  const updates: Partial<typeof nbfcLoanAgreements.$inferInsert> = {
    status: parsed.canonical,
    provider_raw_status: parsed.providerRawStatus,
    provider_raw_payload: { ...existing, last_event: parsed.raw },
    updated_at: now,
  };

  let storedPdf = false;
  if (parsed.canonical === "signed") {
    updates.signed_at = now;
    // §17.4 — store the signed PDF + audit trail ONLY when opted in. Never fail
    // the webhook on a fetch error; fall back to any URLs the webhook carried.
    if (row.store_loan_agreement && row.digio_document_id) {
      try {
        const fetched = await fetchSigned(row);
        updates.signed_document_url = parsed.signedDocumentUrl ?? fetched.signedPdfUrl ?? null;
        updates.audit_trail_url = parsed.auditTrailUrl ?? fetched.auditTrailUrl ?? null;
        storedPdf = !!updates.signed_document_url;
      } catch (err) {
        console.warn("[agreement webhook] signed PDF fetch failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        if (parsed.signedDocumentUrl) updates.signed_document_url = parsed.signedDocumentUrl;
        if (parsed.auditTrailUrl) updates.audit_trail_url = parsed.auditTrailUrl;
      }
    }
  }
  if (parsed.canonical === "failed") {
    updates.failure_reason = `Provider reported ${parsed.providerRawStatus}`;
  }

  await db.update(nbfcLoanAgreements).set(updates).where(eq(nbfcLoanAgreements.id, row.id));
  return { matched: true, status: parsed.canonical, agreementRef: row.agreement_ref, storedPdf };
}
