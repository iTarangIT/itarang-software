import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { coBorrowers, consentRecords, leads } from "@/lib/db/schema";
import { fetchAndStoreSignedConsent } from "./fetch-signed-consent";
import { getDigioBaseUrl, getDigioBasicAuth } from "./client";
import {
  aadhaarMismatchMessage,
  checkAadhaarMatch,
  getExpectedConsentAadhaar,
} from "./aadhaar-match";
import { getConsentSignerIdentity } from "./signer-aadhaar";
import { notifyConsentSigned } from "@/lib/notifications/events";

export const CONSENT_WAITING_STATUSES = [
  "link_sent",
  "link_opened",
  "esign_in_progress",
];

const SIGNED_STATUSES = ["signed", "completed", "executed", "success"];

async function fetchDigioDocument(
  baseUrl: string,
  auth: string,
  documentId: string,
) {
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
      return JSON.parse(text);
    } catch (e) {
      console.error("[sync-consent-status] Digio fetch error:", e);
    }
  }
  return null;
}

type SyncInput = {
  id: string;
  lead_id: string;
  consent_status: string | null;
  signed_consent_url: string | null;
  esign_transaction_id: string | null;
  signer_aadhaar_masked: string | null;
};

type SyncResult = {
  consent_status: string;
  signed_consent_url: string | null;
  signed_at: Date;
  signer_aadhaar_masked: string | null;
};

/**
 * Pulls the latest status from DigiO for a consent record that's still waiting
 * for a signature. If DigiO reports the doc as signed, promotes the record to
 * esign_completed, downloads and stores the signed PDF, updates both the
 * consent_records and leads rows, and returns the merged result. Returns null
 * if the record is no longer waiting, DigiO is unreachable, or the doc is not
 * yet signed.
 *
 * This is the pull-based safety net for the push webhook at
 * /api/webhooks/digio — needed whenever the webhook can't land (e.g., localhost
 * dev without a tunnel, or any transient delivery failure).
 */
export async function syncConsentStatusFromDigio(
  record: SyncInput,
): Promise<SyncResult | null> {
  if (!record.esign_transaction_id) return null;
  if (!CONSENT_WAITING_STATUSES.includes(record.consent_status ?? '')) return null;

  const auth = getDigioBasicAuth();
  if (!auth) return null;

  const baseUrl = getDigioBaseUrl();
  const parsed = await fetchDigioDocument(
    baseUrl,
    auth,
    record.esign_transaction_id,
  );
  if (!parsed) return null;

  const signingParties = Array.isArray(parsed?.signing_parties)
    ? parsed.signing_parties
    : [];
  const firstParty = signingParties[0] || {};
  const rawStatus = String(
    parsed?.agreement_status || parsed?.status || firstParty?.status || "",
  ).toLowerCase();

  if (!SIGNED_STATUSES.includes(rawStatus)) return null;

  const now = new Date();
  // Read the signer's Aadhaar from pki_signature_details.aadhaar_suffix (the real
  // field), with legacy fallbacks.
  const signerIdentity = getConsentSignerIdentity(parsed);
  const signerAadhaar =
    signerIdentity.suffix ||
    firstParty?.aadhaar_masked ||
    firstParty?.signer_aadhaar ||
    record.signer_aadhaar_masked ||
    null;

  // Integrity gate (mirror of the webhook): reject a consent signed with an
  // Aadhaar that doesn't match the captured Aadhaar (primary → customer,
  // co-borrower → co-borrower). Never block when not comparable. Read
  // consent_for / retry count straight from the DB so a co-borrower is compared
  // against the co-borrower's own Aadhaar, never the primary's.
  const [meta] = await db
    .select({
      consent_for: consentRecords.consent_for,
      esign_retry_count: consentRecords.esign_retry_count,
    })
    .from(consentRecords)
    .where(eq(consentRecords.id, record.id))
    .limit(1);
  if (meta) {
    const expected = await getExpectedConsentAadhaar(
      record.lead_id,
      meta.consent_for,
    );
    const check = checkAadhaarMatch(expected, signerAadhaar);
    if (check.comparable && !check.match) {
      const retryCount = (meta.esign_retry_count || 0) + 1;
      const newStatus = retryCount >= 3 ? "esign_blocked" : "esign_failed";
      console.warn("[sync-consent-status] Aadhaar mismatch — rejecting consent", {
        documentId: record.esign_transaction_id,
        leadId: record.lead_id,
        consentFor: meta.consent_for,
        signerLast4: check.signerLast4,
        expectedLast4: check.expectedLast4,
      });
      await db
        .update(consentRecords)
        .set({
          consent_status: newStatus,
          signer_aadhaar_masked: signerAadhaar,
          signer_name_match_score: signerIdentity.nameScore,
          esign_retry_count: retryCount,
          esign_error_message: aadhaarMismatchMessage(check),
          updated_at: now,
        })
        .where(eq(consentRecords.id, record.id));
      // Reflect on the correct applicant row.
      if (meta.consent_for === "co_borrower") {
        await db
          .update(coBorrowers)
          .set({ consent_status: newStatus, updated_at: now })
          .where(eq(coBorrowers.lead_id, record.lead_id));
        await db
          .update(leads)
          .set({ borrower_consent_status: newStatus, updated_at: now })
          .where(eq(leads.id, record.lead_id));
      } else {
        await db
          .update(leads)
          .set({ consent_status: newStatus, updated_at: now })
          .where(eq(leads.id, record.lead_id));
      }
      return null;
    }
  }

  let signedUrl = record.signed_consent_url;
  if (!signedUrl) {
    const stored = await fetchAndStoreSignedConsent(
      record.esign_transaction_id,
      record.lead_id,
    );
    if (stored?.publicUrl) {
      signedUrl = stored.publicUrl;
    } else {
      console.warn("[sync-consent-status] Failed to fetch/store signed PDF", {
        documentId: record.esign_transaction_id,
        leadId: record.lead_id,
        consentId: record.id,
      });
    }
  }

  const updates = {
    consent_status: "esign_completed",
    signed_at: now,
    signer_aadhaar_masked: signerAadhaar,
    signer_name_match_score: signerIdentity.nameScore,
    ...(signedUrl ? { signed_consent_url: signedUrl } : {}),
    updated_at: now,
  };

  await db
    .update(consentRecords)
    .set(updates)
    .where(eq(consentRecords.id, record.id));

  await db
    .update(leads)
    .set({ consent_status: "esign_completed", updated_at: now })
    .where(eq(leads.id, record.lead_id));

  // Announced only once the Aadhaar integrity gate above has PASSED — a consent
  // signed with the wrong Aadhaar returns early and must never be reported as
  // signed. Says who signed and in which capacity, which is the whole point of
  // that gate: a co-borrower signing in the borrower's place is exactly what it
  // exists to catch.
  await notifyConsentSigned({
    leadId: record.lead_id,
    signerName: signerIdentity.name ?? null,
    signerRole: meta?.consent_for === "co_borrower" ? "co_borrower" : "borrower",
    method: "esign",
  });

  return {
    consent_status: "esign_completed",
    signed_consent_url: signedUrl,
    signed_at: now,
    signer_aadhaar_masked: signerAadhaar,
  };
}
