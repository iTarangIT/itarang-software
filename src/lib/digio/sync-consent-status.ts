import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { consentRecords, leads } from "@/lib/db/schema";
import { fetchAndStoreSignedConsent } from "./fetch-signed-consent";

export const CONSENT_WAITING_STATUSES = [
  "link_sent",
  "link_opened",
  "esign_in_progress",
];

const SIGNED_STATUSES = ["signed", "completed", "executed", "success"];

function cleanEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

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
  consent_status: string;
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
  if (!CONSENT_WAITING_STATUSES.includes(record.consent_status)) return null;

  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  const baseUrl =
    cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";
  if (!clientId || !clientSecret) return null;

  const auth = basicAuthHeader(clientId, clientSecret);
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
  const signerAadhaar =
    firstParty?.aadhaar_masked ||
    firstParty?.signer_aadhaar ||
    record.signer_aadhaar_masked ||
    null;

  let signedUrl = record.signed_consent_url;
  if (!signedUrl) {
    const stored = await fetchAndStoreSignedConsent(
      record.esign_transaction_id,
      record.lead_id,
    );
    if (stored?.publicUrl) signedUrl = stored.publicUrl;
  }

  const updates = {
    consent_status: "esign_completed",
    signed_at: now,
    signer_aadhaar_masked: signerAadhaar,
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

  return {
    consent_status: "esign_completed",
    signed_consent_url: signedUrl,
    signed_at: now,
    signer_aadhaar_masked: signerAadhaar,
  };
}
