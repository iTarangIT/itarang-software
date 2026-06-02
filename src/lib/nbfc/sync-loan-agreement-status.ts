/**
 * Pull-based reconciliation of the NBFC LOAN-AGREEMENT signing status from the
 * eSign provider (Digio) — BRD Addendum V0.3.1 §17.
 *
 * Why: the only thing that flips an in_progress loan-agreement row to `signed`
 * is the Digio webhook (/api/digio/webhook/loan-agreement). In local dev the
 * webhook can't reach the box, and even on a server the callback can be missed
 * for the uploadpdf path, so a fully-signed agreement stays stuck on
 * "Awaiting signature" forever and the success UI + download buttons never
 * appear. This helper closes that gap by polling Digio's GET document API on
 * page load and promoting the row to `signed` / `failed`.
 *
 * Best-effort: never throws. If Digio is unreachable we render whatever is in
 * the DB. Idempotent — terminal rows short-circuit, and the webhook remains the
 * authoritative path (this only fills the gap when it doesn't arrive).
 *
 * Called from: GET /api/nbfc/agreement/[leadId].
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements } from "@/lib/db/schema";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";
import { getLatestAgreement } from "@/lib/nbfc/agreement";
import { fetchSignedLoanAgreementPdfAndAuditTrail } from "@/lib/nbfc/fetchSignedAgreementPdf";

interface DigioParty {
  identifier?: string;
  customer_identifier?: string;
  status?: string;
}

interface DigioDocResponse {
  agreement_status?: string;
  status?: string;
  signing_parties?: DigioParty[];
  [k: string]: unknown;
}

// Digio document-level states that mean every signer is done.
const COMPLETE_STATUSES = new Set(["COMPLETED", "SIGNED", "EXECUTED"]);
const FAILED_STATUSES = new Set(["FAILED", "EXPIRED", "CANCELLED", "DECLINED"]);
// Per-party signed markers (used when the doc-level status lags but all parties
// have individually signed).
const PARTY_SIGNED_STATUSES = new Set(["signed", "completed", "executed", "success"]);

async function fetchDigioDocument(
  baseUrl: string,
  auth: string,
  documentId: string,
): Promise<DigioDocResponse | null> {
  const urls = [
    `${baseUrl}/v2/client/document/${encodeURIComponent(documentId)}`,
    `${baseUrl}/v2/client/document/status/${encodeURIComponent(documentId)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: auth, Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text) continue;
      return JSON.parse(text) as DigioDocResponse;
    } catch (err) {
      console.warn("[sync-loan-agreement-status] Digio fetch error", {
        url,
        err: err instanceof Error ? err.message : err,
      });
    }
  }
  return null;
}

/**
 * Reconcile the latest loan-agreement row for (lead, nbfc) against Digio.
 * No-op unless the row is `in_progress` with an eSign document id.
 */
export async function syncLoanAgreementStatusFromDigio(
  leadId: string,
  nbfcId: number,
): Promise<void> {
  try {
    const row = await getLatestAgreement(leadId, nbfcId);
    if (!row) return;
    if (row.status !== "in_progress") return; // terminal/pending — nothing to pull
    if (!row.digio_document_id) return; // upload/manual path — no provider to poll

    const auth = getDigioBasicAuth();
    if (!auth) return;
    const baseUrl = getDigioBaseUrl();
    const parsed = await fetchDigioDocument(baseUrl, auth, row.digio_document_id);
    if (!parsed) return;

    const rawStatus = String(parsed.agreement_status ?? parsed.status ?? "").toUpperCase();
    const parties: DigioParty[] = Array.isArray(parsed.signing_parties) ? parsed.signing_parties : [];
    const allPartiesSigned =
      parties.length > 0 &&
      parties.every((p) => PARTY_SIGNED_STATUSES.has(String(p?.status ?? "").toLowerCase()));

    const isComplete = COMPLETE_STATUSES.has(rawStatus) || allPartiesSigned;
    const isFailed = FAILED_STATUSES.has(rawStatus);
    if (!isComplete && !isFailed) return; // still mid-signing — leave in_progress

    const now = new Date();
    const existing = (row.provider_raw_payload as Record<string, unknown>) ?? {};

    if (isComplete) {
      const updates: Partial<typeof nbfcLoanAgreements.$inferInsert> = {
        status: "signed",
        signed_at: now,
        provider_raw_status: rawStatus || "COMPLETED",
        provider_raw_payload: { ...existing, last_pull: parsed, last_pull_at: now.toISOString() },
        updated_at: now,
      };
      // §17.4 — store the signed PDF + audit trail only when the NBFC opted in.
      // Mirrors the webhook; the download proxies still fetch live on demand.
      if (row.store_loan_agreement && row.digio_document_id) {
        try {
          const fetched = await fetchSignedLoanAgreementPdfAndAuditTrail({
            leadId: row.lead_id,
            digioDocumentId: row.digio_document_id,
          });
          updates.signed_document_url = fetched.signedPdfUrl ?? null;
          updates.audit_trail_url = fetched.auditTrailUrl ?? null;
        } catch (err) {
          console.warn("[sync-loan-agreement-status] signed PDF fetch failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await db.update(nbfcLoanAgreements).set(updates).where(eq(nbfcLoanAgreements.id, row.id));
      console.info("[sync-loan-agreement-status] promoted to signed", {
        leadId,
        nbfcId,
        agreementId: row.id,
        digioStatus: rawStatus,
      });
      return;
    }

    // isFailed
    await db
      .update(nbfcLoanAgreements)
      .set({
        status: "failed",
        provider_raw_status: rawStatus,
        failure_reason: `Digio reported ${rawStatus}`,
        provider_raw_payload: { ...existing, last_pull: parsed, last_pull_at: now.toISOString() },
        updated_at: now,
      })
      .where(eq(nbfcLoanAgreements.id, row.id));
    console.info("[sync-loan-agreement-status] marked failed", {
      leadId,
      nbfcId,
      agreementId: row.id,
      digioStatus: rawStatus,
    });
  } catch (err) {
    console.warn("[sync-loan-agreement-status] unexpected error", err);
  }
}
