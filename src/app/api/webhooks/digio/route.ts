import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  coBorrowers,
  consentRecords,
  leads,
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";
import { ensureAdminKycQueueEntry } from "@/lib/kyc/admin-workflow";
import { fetchSignedLspPdfAndAuditTrail } from "@/lib/queue/jobs/fetchSignedLspPdfJob";

/**
 * Map a raw Digio webhook status (case-insensitive) onto the shared 7-state
 * agreement_status ENUM used by NBFC LSP agreements (BRD §3.5). Anything
 * unrecognised passes through as upper-cased — the column is varchar(32).
 */
function mapDigioStatusToAgreement(raw: string): {
  agreementStatus: string;
  terminal: "completed" | "failed" | "expired" | null;
} {
  const s = raw.toLowerCase();
  if (s === "signed") return { agreementStatus: "SIGNED", terminal: null };
  if (
    s === "completed" ||
    s === "executed" ||
    s === "success"
  ) {
    return { agreementStatus: "COMPLETED", terminal: "completed" };
  }
  if (s === "partially_signed") {
    return { agreementStatus: "PARTIALLY_SIGNED", terminal: null };
  }
  if (s === "sign_pending" || s === "pending") {
    return { agreementStatus: "SIGN_PENDING", terminal: null };
  }
  if (
    s === "failed" ||
    s === "rejected" ||
    s === "declined" ||
    s === "cancelled" ||
    s === "error"
  ) {
    return { agreementStatus: "FAILED", terminal: "failed" };
  }
  if (s === "expired") return { agreementStatus: "EXPIRED", terminal: "expired" };
  return { agreementStatus: raw.toUpperCase(), terminal: null };
}

/**
 * Per-signer event extraction. Digio includes a `signing_parties` array on
 * agreement webhooks; each entry carries the signer identifier (email),
 * sign timestamp, and per-party status. Some sandbox events ship a flatter
 * `signer_identifier` at the top level — handle both shapes.
 */
interface SignerEvent {
  identifier: string;
  rawStatus: string;
  signedAt: Date | null;
}

function extractSignerEvents(body: Record<string, unknown>): SignerEvent[] {
  const out: SignerEvent[] = [];
  const parties =
    (body.signing_parties as unknown[] | undefined) ||
    (body.signers as unknown[] | undefined) ||
    [];
  for (const p of parties) {
    if (!p || typeof p !== "object") continue;
    const party = p as Record<string, unknown>;
    const identifier =
      (party.identifier as string | undefined) ||
      (party.email as string | undefined) ||
      (party.signer_identifier as string | undefined) ||
      "";
    if (!identifier) continue;
    const rawStatus = String(
      party.status || party.signing_status || party.party_status || "",
    ).toLowerCase();
    const signedAtRaw =
      (party.signed_at as string | undefined) ||
      (party.signing_date as string | undefined) ||
      null;
    const signedAt =
      signedAtRaw && !Number.isNaN(Date.parse(signedAtRaw))
        ? new Date(signedAtRaw)
        : null;
    out.push({ identifier, rawStatus, signedAt });
  }
  // Top-level fallback when Digio just sends one signer.
  if (out.length === 0 && typeof body.signer_identifier === "string") {
    out.push({
      identifier: body.signer_identifier,
      rawStatus: String(body.status || "").toLowerCase(),
      signedAt: null,
    });
  }
  return out;
}

function mapSignerStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "signed" || s === "completed" || s === "success") return "signed";
  if (s === "failed" || s === "rejected" || s === "error") return "failed";
  if (s === "declined" || s === "cancelled") return "declined";
  if (s === "expired") return "expired";
  if (s === "sent" || s === "pending" || s === "sign_pending") return "sent";
  return s || "sent";
}

async function applySignerEvents(
  agreementRowId: number,
  events: SignerEvent[],
  now: Date,
): Promise<void> {
  for (const ev of events) {
    const mapped = mapSignerStatus(ev.rawStatus);
    const patch: Record<string, unknown> = {
      signing_status: mapped,
      last_status_event_at: now,
    };
    if (mapped === "signed") {
      patch.signed_at = ev.signedAt ?? now;
    }
    await db
      .update(nbfcLspAgreementSigners)
      .set(patch)
      .where(
        and(
          eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreementRowId),
          eq(nbfcLspAgreementSigners.email, ev.identifier),
        ),
      );
  }
}

/**
 * NBFC LSP Agreement webhook handler.
 *
 * Updates:
 *   1. agreement_status on the parent row.
 *   2. per-signer status + signed_at on nbfc_lsp_agreement_signers when
 *      `signing_parties[]` (or `signers[]`) is present on the payload.
 *   3. on COMPLETED: download the signed PDF + audit trail to the local
 *      public folder, stamp the URLs, link nbfc.lsp_agreement_id, and
 *      auto-activate the NBFC (E-112).
 *
 * Returns true if this was an NBFC LSP webhook; false if no NBFC row matched
 * (let the caller fall through).
 */
async function maybeHandleNbfcLspWebhook(
  documentId: string,
  rawStatus: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({
      id: nbfcLspAgreements.id,
      nbfc_id: nbfcLspAgreements.nbfc_id,
      agreement_status: nbfcLspAgreements.agreement_status,
      completed_at: nbfcLspAgreements.completed_at,
      signed_pdf_url: nbfcLspAgreements.signed_pdf_url,
      audit_trail_url: nbfcLspAgreements.audit_trail_url,
    })
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.digio_document_id, documentId))
    .limit(1);

  if (!row) return false;

  const { agreementStatus, terminal } = mapDigioStatusToAgreement(rawStatus);
  const patch: Record<string, unknown> = {
    agreement_status: agreementStatus,
    updated_at: now,
    last_webhook_payload: body,
  };
  if (terminal === "completed" && !row.completed_at) {
    patch.completed_at = now;
  }
  await db
    .update(nbfcLspAgreements)
    .set(patch)
    .where(eq(nbfcLspAgreements.id, row.id));

  // 2. Per-signer events. Digio's payload shape varies — if no signing_parties
  // array is present and this is a terminal "completed", stamp every signer
  // as 'signed' so the UI doesn't strand them on 'sent' forever.
  const signerEvents = extractSignerEvents(body);
  if (signerEvents.length > 0) {
    await applySignerEvents(row.id, signerEvents, now);
  } else if (terminal === "completed") {
    await db
      .update(nbfcLspAgreementSigners)
      .set({ signing_status: "signed", signed_at: now, last_status_event_at: now })
      .where(eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, row.id));
  }

  // 3. On COMPLETED: link NBFC, download signed PDF + audit trail, auto-activate.
  if (terminal === "completed") {
    await db
      .update(nbfc)
      .set({ lsp_agreement_id: row.id, updated_at: now })
      .where(eq(nbfc.id, row.nbfc_id));

    // Download signed PDF + audit trail unless we already have them.
    if (!row.signed_pdf_url || !row.audit_trail_url) {
      try {
        const result = await fetchSignedLspPdfAndAuditTrail({
          agreementRowId: row.id,
          nbfcId: row.nbfc_id,
          digioDocumentId: documentId,
        });
        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (result.signedPdfUrl && !row.signed_pdf_url) {
          updates.signed_pdf_url = result.signedPdfUrl;
        }
        if (result.auditTrailUrl && !row.audit_trail_url) {
          updates.audit_trail_url = result.auditTrailUrl;
        }
        if (Object.keys(updates).length > 1) {
          await db
            .update(nbfcLspAgreements)
            .set(updates)
            .where(eq(nbfcLspAgreements.id, row.id));
        }
      } catch (err) {
        console.error(
          "[DigiO Webhook] NBFC LSP PDF download failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Activation is admin-gated. The webhook used to call activateNbfc here
    // the moment Digio reported COMPLETED, but the NBFC now stays at
    // status='approved' until an admin/sales-head clicks "Activate Account"
    // on /admin/nbfc/[id]/review. The manual endpoint reuses activateNbfc.
  }

  console.log(
    `[DigiO Webhook] NBFC LSP ${row.id} agreement_status → ${agreementStatus}; signer events: ${signerEvents.length}`,
  );
  return true;
}

// Update consent_status on the appropriate applicant-level rows so initial
// page loads and downstream consumers see the latest state without having to
// re-derive from consent_records. For the co-borrower path we update both
// coBorrowers.consent_status (canonical) and leads.borrower_consent_status
// (denormalised cache the dealer page reads on first render).
async function syncApplicantConsentStatus(
  consentFor: string | null | undefined,
  leadId: string,
  status: string,
  now: Date,
) {
  if (consentFor === "co_borrower") {
    await db.update(coBorrowers)
      .set({ consent_status: status, updated_at: now })
      .where(eq(coBorrowers.lead_id, leadId));
    await db.update(leads)
      .set({ borrower_consent_status: status, updated_at: now })
      .where(eq(leads.id, leadId));
  } else {
    await db.update(leads)
      .set({ consent_status: status, updated_at: now })
      .where(eq(leads.id, leadId));
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("[DigiO Webhook] Received:", JSON.stringify(body, null, 2));

    const documentId = body.digio_doc_id || body.document_id || body.id;
    const rawStatus = String(body.status || body.agreement_status || "").toLowerCase();

    if (!documentId) {
      console.warn("[DigiO Webhook] No document_id in payload");
      return NextResponse.json({ received: true });
    }

    // Find the consent record with this DigiO document ID
    const records = await db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.esign_transaction_id, documentId))
      .limit(1);

    if (!records.length) {
      // Fall through to the NBFC LSP agreement handler — same Digio endpoint
      // services both flows (Sync Audit G-06 / NBFC Onboarding Plan §3.6).
      const now = new Date();
      const handled = await maybeHandleNbfcLspWebhook(
        documentId,
        rawStatus,
        body as Record<string, unknown>,
        now,
      );
      if (!handled) {
        console.warn(
          "[DigiO Webhook] No consent record OR NBFC LSP agreement found for document:",
          documentId,
        );
      }
      return NextResponse.json({ received: true });
    }

    const record = records[0];
    const now = new Date();

    const signedStatuses = ["signed", "completed", "executed", "success"];
    const failedStatuses = ["failed", "rejected", "declined", "cancelled", "error"];
    const expiredStatuses = ["expired"];

    if (signedStatuses.includes(rawStatus)) {
      console.log("[DigiO Webhook] Document signed:", documentId);

      const updates: any = {
        consent_status: "esign_completed",
        signed_at: now,
        updated_at: now,
      };

      // Extract signer details from webhook payload
      const signingParties = body.signing_parties || [];
      const signer = signingParties[0];
      if (signer?.aadhaar_masked || signer?.signer_aadhaar) {
        updates.signer_aadhaar_masked = signer.aadhaar_masked || signer.signer_aadhaar;
      }

      // Download signed PDF from DigiO and store in Supabase
      if (!record.signed_consent_url) {
        const stored = await fetchAndStoreSignedConsent(documentId, record.lead_id);
        if (stored?.publicUrl) {
          updates.signed_consent_url = stored.publicUrl;
          console.log("[DigiO Webhook] Signed PDF stored:", stored.publicUrl);
        } else {
          console.warn("[DigiO Webhook] Failed to fetch/store signed PDF", {
            documentId,
            leadId: record.lead_id,
            consentId: record.id,
          });
        }
      }

      await db.update(consentRecords).set(updates).where(eq(consentRecords.id, record.id));
      await syncApplicantConsentStatus(record.consent_for, record.lead_id, "esign_completed", now);

      // Surface the lead on /admin/kyc-review now that the customer has signed
      // — admin still needs to verify the consent before the dealer can submit.
      await ensureAdminKycQueueEntry(record.lead_id);

    } else if (failedStatuses.includes(rawStatus)) {
      console.log("[DigiO Webhook] Document failed:", documentId, rawStatus);

      const retryCount = (record.esign_retry_count || 0) + 1;
      const newStatus = retryCount >= 3 ? "esign_blocked" : "esign_failed";

      await db.update(consentRecords).set({
        consent_status: newStatus,
        esign_retry_count: retryCount,
        esign_error_message: body.failure_reason || body.message || "eSign failed",
        updated_at: now,
      }).where(eq(consentRecords.id, record.id));

      await syncApplicantConsentStatus(record.consent_for, record.lead_id, newStatus, now);

    } else if (expiredStatuses.includes(rawStatus)) {
      console.log("[DigiO Webhook] Document expired:", documentId);

      await db.update(consentRecords).set({
        consent_status: "expired",
        updated_at: now,
      }).where(eq(consentRecords.id, record.id));

      await syncApplicantConsentStatus(record.consent_for, record.lead_id, "expired", now);

    } else {
      console.log("[DigiO Webhook] Unhandled status:", rawStatus, "for document:", documentId);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("[DigiO Webhook] Error:", error);
    // Always return 200 so DigiO doesn't retry indefinitely
    return NextResponse.json({ received: true });
  }
}
