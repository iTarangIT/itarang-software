import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { coBorrowers, consentRecords, leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";

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
      console.warn("[DigiO Webhook] No consent record found for document:", documentId);
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
