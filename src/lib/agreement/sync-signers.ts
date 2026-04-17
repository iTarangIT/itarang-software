import { Buffer } from "node:buffer";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeEmail(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

/** Map Digio party-status strings to the values our UI renders. */
export function normalizeSignerStatus(value: unknown) {
  const safe = String(value ?? "").trim().toLowerCase();
  if (!safe) return "sent";
  if (["requested", "sequenced", "pending", "sent"].includes(safe)) return "sent";
  if (["signed", "completed", "executed", "success"].includes(safe)) return "signed";
  if (["viewed", "opened", "document_viewed"].includes(safe)) return "viewed";
  if (["failed", "rejected", "cancelled", "declined"].includes(safe)) return "failed";
  if (["expired"].includes(safe)) return "expired";
  return safe;
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
): Promise<{ updated: number; transitions: number }> {
  const signingParties: any[] = Array.isArray(parsed?.signing_parties)
    ? parsed.signing_parties
    : Array.isArray(parsed?.signingParties)
      ? parsed.signingParties
      : [];

  if (!signingParties.length) return { updated: 0, transitions: 0 };

  const existing = await db
    .select()
    .from(dealerAgreementSigners)
    .where(eq(dealerAgreementSigners.applicationId, applicationId));

  if (!existing.length) return { updated: 0, transitions: 0 };

  let updated = 0;
  let transitions = 0;

  for (const party of signingParties) {
    const partyEmail = normalizeEmail(
      party?.email || party?.signer_email || party?.identifier || party?.signerIdentifier,
    );
    const partyReason = String(party?.reason || party?.role || "").toLowerCase();

    const match =
      existing.find((s) => {
        const sigEmail = normalizeEmail(s.signerEmail);
        return !!partyEmail && !!sigEmail && partyEmail === sigEmail;
      }) ||
      existing.find((s) => {
        if (!partyReason) return false;
        const sigRole = String(s.signerRole || "").toLowerCase().replace(/_/g, " ");
        return sigRole && partyReason.includes(sigRole);
      });

    if (!match) continue;

    const newStatus = normalizeSignerStatus(party?.status);
    const signedOnRaw = party?.signed_on || party?.signed_at || party?.signedOn;
    const parsedSignedAt =
      typeof signedOnRaw === "string" && signedOnRaw.trim()
        ? new Date(signedOnRaw)
        : newStatus === "signed"
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

    const statusChanged = newStatus !== match.signerStatus;
    const signedAtChanged =
      !!signedAt && (!match.signedAt || match.signedAt.getTime() !== signedAt.getTime());

    if (!statusChanged && !signedAtChanged) {
      await db
        .update(dealerAgreementSigners)
        .set({ providerRawResponse: party, updatedAt: new Date() })
        .where(eq(dealerAgreementSigners.id, match.id));
      continue;
    }

    await db
      .update(dealerAgreementSigners)
      .set({
        signerStatus: newStatus,
        signedAt: signedAt ?? match.signedAt,
        lastEventAt: new Date(),
        signingMethod: newSigningMethod ?? match.signingMethod,
        providerRawResponse: party,
        updatedAt: new Date(),
      })
      .where(eq(dealerAgreementSigners.id, match.id));
    updated++;

    if (statusChanged) {
      transitions++;
      try {
        await db.insert(dealerAgreementEvents).values({
          applicationId,
          providerDocumentId,
          requestId,
          eventType: newStatus === "signed" ? "signer_signed" : `signer_${newStatus}`,
          signerRole: match.signerRole,
          eventStatus: newStatus,
          eventPayload: party,
          createdAt: new Date(),
        });
      } catch (err) {
        console.warn("[SYNC SIGNERS] failed to insert signer event:", err);
      }
    }
  }

  return { updated, transitions };
}

/**
 * Fetch the Digio document for a given document id and sync per-signer status.
 * Returns the parsed Digio response on success, null on failure.
 */
export async function fetchDigioAndSyncSigners(params: {
  applicationId: string;
  providerDocumentId: string;
  requestId?: string | null;
}): Promise<Record<string, unknown> | null> {
  const { applicationId, providerDocumentId, requestId } = params;

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
