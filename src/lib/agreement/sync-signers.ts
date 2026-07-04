import { Buffer } from "node:buffer";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { checkAadhaarMatch } from "@/lib/digio/aadhaar-match";

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeEmail(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

// Map the local signerRole (stored in snake_case on dealer_agreement_signers)
// to the Digio `reason` string used when the party was created at
// src/app/api/admin/dealer-verifications/[dealerId]/initiate-agreement/route.ts.
// Used by the email-less fallback match below — without this, naive
// substring matching fails for itarang rows because 'itarang signer 1'
// cannot contain the longer 'itarang signatory 1'.
const SIGNER_ROLE_TO_DIGIO_REASON: Record<string, string> = {
  dealer: "dealer signer",
  itarang_signatory_1: "itarang signer 1",
  itarang_signatory_2: "itarang signer 2",
};

/** Map Digio party-status strings to the values our UI renders.
 *  Unknown values collapse to "sent" so an upstream Digio change can't
 *  introduce arbitrary statuses into dealer_agreement_signers.signer_status
 *  or emit unbounded `signer_${status}` event types. */
export function normalizeSignerStatus(value: unknown) {
  const safe = String(value ?? "").trim().toLowerCase();
  if (!safe) return "sent";
  if (["requested", "sequenced", "pending", "sent"].includes(safe)) return "sent";
  if (["signed", "completed", "executed", "success"].includes(safe)) return "signed";
  if (["viewed", "opened", "document_viewed"].includes(safe)) return "viewed";
  if (["failed", "rejected", "cancelled", "declined"].includes(safe)) return "failed";
  if (["expired"].includes(safe)) return "expired";
  return "sent";
}

/**
 * Sync per-signer status from Digio's signing_parties array into dealer_agreement_signers.
 * Matches a Digio party to a local signer row by email (preferred) or by role/reason token.
 * Writes one dealer_agreement_events row for every status transition so the timeline reflects it.
 */
export async function syncSignersFromDigio(
  applicationId: string,
  providerDocumentId: string | null,
  requestId: string | null,
  parsed: any,
): Promise<{
  updated: number;
  transitions: number;
  dealerAadhaarMismatch: boolean;
  mismatchReason?: string;
}> {
  const signingParties: any[] = Array.isArray(parsed?.signing_parties)
    ? parsed.signing_parties
    : Array.isArray(parsed?.signingParties)
      ? parsed.signingParties
      : [];

  if (!signingParties.length)
    return { updated: 0, transitions: 0, dealerAadhaarMismatch: false };

  const existing = await db
    .select()
    .from(dealerAgreementSigners)
    .where(eq(dealerAgreementSigners.application_id, applicationId));

  if (!existing.length)
    return { updated: 0, transitions: 0, dealerAadhaarMismatch: false };

  // E-175 — the owner's captured Aadhaar, to verify the DEALER signed with their
  // own Aadhaar (Aadhaar eSign). null → can't compare → don't block.
  const [appRow] = await db
    .select({ ownerAadhaar: dealerOnboardingApplications.owner_aadhaar_no })
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);
  const ownerAadhaar = appRow?.ownerAadhaar ?? null;
  let dealerAadhaarMismatch = false;
  let mismatchReason: string | undefined;

  let updated = 0;
  let transitions = 0;

  for (const party of signingParties) {
    const partyEmail = normalizeEmail(
      party?.email || party?.signer_email || party?.identifier || party?.signerIdentifier,
    );
    const partyReason = String(party?.reason || party?.role || "").toLowerCase();

    const match =
      existing.find((s) => {
        const sigEmail = normalizeEmail(s.signer_email);
        return !!partyEmail && !!sigEmail && partyEmail === sigEmail;
      }) ||
      existing.find((s) => {
        if (!partyReason) return false;
        const roleKey = String(s.signer_role || "").toLowerCase();
        // Exact alias match covers the role/reason vocabulary gap
        // (e.g. signerRole='itarang_signatory_1' ↔ reason='iTarang signer 1').
        const expectedReason = SIGNER_ROLE_TO_DIGIO_REASON[roleKey];
        if (expectedReason && partyReason === expectedReason) return true;
        // Legacy substring fallback for any role not in the alias map.
        const sigRole = roleKey.replace(/_/g, " ");
        return sigRole && partyReason.includes(sigRole);
      });

    if (!match) continue;

    const newStatus = normalizeSignerStatus(party?.status);

    // E-175 — reject a DEALER signature made with an Aadhaar that doesn't match
    // the owner's captured Aadhaar. The signer is forced to 'failed' so the
    // agreement can't complete; the caller turns this into a failed agreement.
    let effectiveStatus = newStatus;
    if (
      String(match.signer_role || "").toLowerCase() === "dealer" &&
      newStatus === "signed"
    ) {
      const signerAadhaar =
        (party?.aadhaar_masked as string | undefined) ||
        (party?.signer_aadhaar as string | undefined) ||
        (party?.aadhaar as string | undefined) ||
        null;
      const check = checkAadhaarMatch(ownerAadhaar, signerAadhaar);
      if (check.comparable && !check.match) {
        effectiveStatus = "failed";
        dealerAadhaarMismatch = true;
        mismatchReason =
          `Aadhaar mismatch: the dealer agreement was signed with an Aadhaar ending ` +
          `${check.signerLast4}, but the owner's Aadhaar on file ends ` +
          `${check.expectedLast4}. The owner must re-sign with their own Aadhaar.`;
        console.warn("[SYNC SIGNERS] dealer Aadhaar mismatch — rejecting", {
          applicationId,
          signerLast4: check.signerLast4,
          expectedLast4: check.expectedLast4,
        });
      }
    }

    const signedOnRaw = party?.signed_on || party?.signed_at || party?.signedOn;
    const parsedSignedAt =
      typeof signedOnRaw === "string" && signedOnRaw.trim()
        ? new Date(signedOnRaw)
        : effectiveStatus === "signed"
          ? new Date()
          : null;
    const signedAt =
      parsedSignedAt && Number.isFinite(parsedSignedAt.getTime()) ? parsedSignedAt : null;

    const newSigningMethod = pickString(
      party?.sign_type,
      party?.signing_method,
      party?.signingMethod,
      party?.type,
    );

    const statusChanged = effectiveStatus !== match.signer_status;
    const signedAtChanged =
      !!signedAt && (!match.signed_at || match.signed_at.getTime() !== signedAt.getTime());

    if (!statusChanged && !signedAtChanged) {
      await db
        .update(dealerAgreementSigners)
        .set({ provider_raw_response: party, updated_at: new Date() })
        .where(eq(dealerAgreementSigners.id, match.id));
      continue;
    }

    await db
      .update(dealerAgreementSigners)
      .set({
        signer_status: effectiveStatus,
        signed_at: effectiveStatus === "signed" ? signedAt ?? match.signed_at : match.signed_at,
        last_event_at: new Date(),
        signing_method: newSigningMethod ?? match.signing_method,
        provider_raw_response: party,
        updated_at: new Date(),
      })
      .where(eq(dealerAgreementSigners.id, match.id));
    updated++;

    if (statusChanged) {
      transitions++;
      try {
        await db.insert(dealerAgreementEvents).values({
          application_id: applicationId,
          provider_document_id: providerDocumentId,
          request_id: requestId,
          event_type:
            effectiveStatus === "signed" ? "signer_signed" : `signer_${effectiveStatus}`,
          signer_role: match.signer_role,
          event_status: effectiveStatus,
          event_payload: party,
          created_at: new Date(),
        });
      } catch (err) {
        console.warn("[SYNC SIGNERS] failed to insert signer event:", err);
      }
    }
  }

  // On a dealer Aadhaar mismatch, fail the agreement so it can't complete. This
  // covers callers (e.g. agreement-tracking) that don't write agreement_status
  // themselves; refresh-agreement additionally honours the returned flag so its
  // own status write doesn't overwrite this back to "completed".
  if (dealerAadhaarMismatch) {
    await db
      .update(dealerOnboardingApplications)
      .set({
        agreement_status: "failed",
        agreement_failure_reason: mismatchReason,
        agreement_failed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, applicationId));
  }

  return { updated, transitions, dealerAadhaarMismatch, mismatchReason };
}

/**
 * Fetch the Digio document for a given document id and sync per-signer status.
 * Returns the parsed Digio response on success, null on failure.
 */
export async function fetchDigioAndSyncSigners(params: {
  application_id: string;
  providerDocumentId: string;
  requestId?: string | null;
}): Promise<Record<string, unknown> | null> {
  const { application_id: applicationId, providerDocumentId, requestId } = params;

  const clientId = process.env.DIGIO_CLIENT_ID?.trim();
  const clientSecret = process.env.DIGIO_CLIENT_SECRET?.trim();
  const baseUrl = (
    process.env.DIGIO_BASE_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://api.digio.in"
      : "https://ext.digio.in:444")
  ).replace(/\/$/, "");

  if (!clientId || !clientSecret) return null;

  const url = `${baseUrl}/v2/client/document/${encodeURIComponent(providerDocumentId)}`;
  const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      console.warn(`[SYNC SIGNERS] Digio ${res.status} @ ${url}`);
      return null;
    }

    const parsed: any = await res.json().catch(() => null);
    if (!parsed) return null;

    await syncSignersFromDigio(applicationId, providerDocumentId, requestId || null, parsed);
    return parsed;
  } catch (err) {
    console.warn(`[SYNC SIGNERS] fetch error @ ${url}:`, err);
    return null;
  }
}
