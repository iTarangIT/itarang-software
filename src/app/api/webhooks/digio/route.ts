import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementSigners,
  dealerOnboardingApplications,
  consentRecords,
  leads,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  mapDigioSignerStatus,
  mapDigioStatusToAgreementStatus,
} from "@/lib/agreement/status";
import { insertAgreementEvent } from "@/lib/agreement/tracking";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function extractSignedAgreementUrl(body: any) {
  return (
    body?.signed_agreement_url ||
    body?.download_url ||
    body?.document_url ||
    body?.file_url ||
    body?.signed_file_url ||
    body?.document?.download_url ||
    body?.document?.file_url ||
    body?.document?.signed_agreement_url ||
    body?.agreement?.download_url ||
    body?.agreement?.file_url ||
    body?.agreement?.signed_agreement_url ||
    body?.data?.download_url ||
    body?.data?.file_url ||
    body?.data?.signed_agreement_url ||
    null
  );
}

function extractAuditTrailUrl(body: any) {
  return (
    body?.audit_trail_url ||
    body?.auditTrailUrl ||
    body?.audit_url ||
    body?.document?.audit_trail_url ||
    body?.document?.auditTrailUrl ||
    body?.agreement?.audit_trail_url ||
    body?.agreement?.auditTrailUrl ||
    body?.data?.audit_trail_url ||
    body?.data?.auditTrailUrl ||
    null
  );
}

function extractFailureReason(body: any) {
  return (
    body?.failure_reason ||
    body?.reason ||
    body?.message ||
    body?.error ||
    body?.error_msg ||
    null
  );
}

async function findApplication(documentId?: string | null, requestId?: string | null) {
  if (documentId) {
    const byDocumentId = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.providerDocumentId, documentId))
      .limit(1);

    if (byDocumentId[0]) return byDocumentId[0];
  }

  if (requestId) {
    const byRequestId = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.requestId, requestId))
      .limit(1);

    if (byRequestId[0]) return byRequestId[0];
  }

  return null;
}

/**
 * Handle Digio webhook for consent eSign documents.
 * Maps Digio statuses to consent state machine.
 */
async function handleConsentWebhook(
  consent: any,
  body: any,
  rawStatus: string,
  documentId: string
) {
  const now = new Date();
  const status = rawStatus.toLowerCase();

  console.log("[DIGIO WEBHOOK - CONSENT] status:", status, "consentId:", consent.id, "leadId:", consent.lead_id);

  const signedPdfUrl = extractSignedAgreementUrl(body);
  const signingParties = Array.isArray(body?.signing_parties) ? body.signing_parties : [];
  const signerAadhaar = signingParties[0]?.aadhaar_masked || signingParties[0]?.signer_aadhaar || null;

  if (status === "completed" || status === "signed") {
    // Fallback — if webhook payload doesn't contain a download URL
    // (common for consent docs), fetch the signed PDF directly from Digio
    // and upload it to our storage so signed_consent_url is always persisted.
    let persistedUrl = signedPdfUrl || consent.signed_consent_url;
    if (!persistedUrl && consent.esign_transaction_id) {
      const stored = await fetchAndStoreSignedConsent(consent.esign_transaction_id, consent.lead_id);
      if (stored?.publicUrl) persistedUrl = stored.publicUrl;
    }

    // eSign completed successfully → set esign_completed (admin picks up for review)
    await db.update(consentRecords).set({
      consent_status: "esign_completed",
      signed_consent_url: persistedUrl,
      signed_at: now,
      signer_aadhaar_masked: signerAadhaar,
      esign_error_code: null,
      esign_error_message: null,
      updated_at: now,
    }).where(eq(consentRecords.id, consent.id));

    await db.update(leads).set({
      consent_status: "esign_completed",
      updated_at: now,
    }).where(eq(leads.id, consent.lead_id));

    console.log("[DIGIO WEBHOOK - CONSENT] eSign completed, signed_consent_url:", persistedUrl);

  } else if (status === "failed" || status === "rejected") {
    // eSign failed
    const failureReason = extractFailureReason(body);
    const retryCount = (consent.esign_retry_count || 0) + 1;
    const newStatus = retryCount >= 3 ? "esign_blocked" : "esign_failed";

    await db.update(consentRecords).set({
      consent_status: newStatus,
      esign_error_code: body?.error_code || body?.errorCode || null,
      esign_error_message: failureReason || "eSign failed",
      esign_retry_count: retryCount,
      updated_at: now,
    }).where(eq(consentRecords.id, consent.id));

    await db.update(leads).set({
      consent_status: newStatus,
      updated_at: now,
    }).where(eq(leads.id, consent.lead_id));

    console.log("[DIGIO WEBHOOK - CONSENT] eSign failed, retryCount:", retryCount, "status:", newStatus);

  } else if (status === "expired") {
    await db.update(consentRecords).set({
      consent_status: "expired",
      updated_at: now,
    }).where(eq(consentRecords.id, consent.id));

    await db.update(leads).set({
      consent_status: "expired",
      updated_at: now,
    }).where(eq(leads.id, consent.lead_id));

    console.log("[DIGIO WEBHOOK - CONSENT] link expired");

  } else if (status === "viewed" || status === "sent") {
    // Customer opened the link
    const mappedStatus = status === "viewed" ? "link_opened" : "link_sent";
    await db.update(consentRecords).set({
      consent_status: mappedStatus,
      updated_at: now,
    }).where(eq(consentRecords.id, consent.id));

    if (mappedStatus !== consent.consent_status) {
      await db.update(leads).set({
        consent_status: mappedStatus,
        updated_at: now,
      }).where(eq(leads.id, consent.lead_id));
    }
  }

  return NextResponse.json({
    success: true,
    type: "consent",
    consentId: consent.id,
    status: rawStatus,
  });
}

export async function POST(req: NextRequest) {
  try {
    let body: any = {};

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid webhook JSON body" },
        { status: 400 }
      );
    }

    const documentId = cleanString(
      body?.document_id || body?.documentId || body?.id || ""
    ) || null;

    const requestId = cleanString(
      body?.request_id || body?.requestId || ""
    ) || null;

    const rawStatus = cleanString(body?.status || "");
    const agreementStatus = mapDigioStatusToAgreementStatus(rawStatus);
    const signedAgreementUrl = extractSignedAgreementUrl(body);
    const auditTrailUrl = extractAuditTrailUrl(body);
    const failureReason = extractFailureReason(body);

    console.log("[DIGIO WEBHOOK] raw status:", rawStatus);
    console.log("[DIGIO WEBHOOK] mapped agreement status:", agreementStatus);
    console.log("[DIGIO WEBHOOK] documentId:", documentId);
    console.log("[DIGIO WEBHOOK] requestId:", requestId);
    console.log("[DIGIO WEBHOOK] signedAgreementUrl:", signedAgreementUrl);
    console.log("[DIGIO WEBHOOK] auditTrailUrl:", auditTrailUrl);

    if (!documentId && !requestId) {
      return NextResponse.json(
        { success: false, message: "document_id or request_id missing" },
        { status: 400 }
      );
    }

    // ── Check if this is a consent document (not a dealer agreement) ────
    if (documentId) {
      const consentRow = await db
        .select()
        .from(consentRecords)
        .where(eq(consentRecords.esign_transaction_id, documentId))
        .limit(1);

      if (consentRow[0]) {
        return handleConsentWebhook(consentRow[0], body, rawStatus, documentId);
      }
    }

    // ── Otherwise, handle as dealer agreement ────────────────────────────
    const application = await findApplication(documentId, requestId);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    const updatePayload: any = {
      agreementStatus,
      requestId: requestId || application.requestId || null,
      providerDocumentId: documentId || application.providerDocumentId || null,
      providerRawResponse: body,
      lastActionTimestamp: new Date(),
      updatedAt: new Date(),
    };

    // In-progress statuses
    if (
      agreementStatus === "sent_to_external_party" ||
      agreementStatus === "partially_signed"
    ) {
      updatePayload.reviewStatus = "agreement_in_progress";
      updatePayload.completionStatus = "pending";
    }

    // Completed
    if (agreementStatus === "completed") {
      updatePayload.reviewStatus = "agreement_completed";
      updatePayload.completionStatus = "completed";
      updatePayload.signedAt = new Date();
      updatePayload.agreementCompletedAt = new Date();

      if (signedAgreementUrl) {
        updatePayload.signedAgreementUrl = signedAgreementUrl;
      }

      if (auditTrailUrl) {
        updatePayload.auditTrailUrl = auditTrailUrl;
      }

      // Auto-fetch/store files directly from Digio (no APP_URL dependency)
      try {
        const digioBaseUrl =
          (process.env.DIGIO_BASE_URL || "https://ext.digio.in:444").trim().replace(/^["']|["']$/g, "");
        const digioClientId =
          (process.env.DIGIO_CLIENT_ID || "").trim().replace(/^["']|["']$/g, "");
        const digioClientSecret =
          (process.env.DIGIO_CLIENT_SECRET || "").trim().replace(/^["']|["']$/g, "");
        const supabaseUrl =
          (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/^["']|["']$/g, "");
        const serviceRoleKey =
          (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim().replace(/^["']|["']$/g, "");

        const docId = documentId || application.providerDocumentId;

        if (digioClientId && digioClientSecret && docId && supabaseUrl && serviceRoleKey) {
          const digioAuth = `Basic ${Buffer.from(`${digioClientId}:${digioClientSecret}`).toString("base64")}`;
          const supabase = createSupabaseClient(supabaseUrl, serviceRoleKey);
          const bucketName = "dealer-documents";

          // Fetch signed agreement PDF from Digio
          if (!signedAgreementUrl) {
            try {
              const signedRes = await fetch(
                `${digioBaseUrl}/v2/client/document/download?document_id=${docId}`,
                { method: "GET", headers: { Authorization: digioAuth, Accept: "application/pdf" }, cache: "no-store" }
              );

              if (signedRes.ok) {
                const contentType = signedRes.headers.get("content-type") || "";
                if (contentType.includes("pdf") || contentType.includes("octet-stream")) {
                  const pdfBuffer = await signedRes.arrayBuffer();
                  if (pdfBuffer.byteLength > 100) {
                    const filePath = `agreements/${application.id}/signed-agreement.pdf`;
                    const { error: upErr } = await supabase.storage
                      .from(bucketName)
                      .upload(filePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

                    if (!upErr) {
                      const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(filePath);
                      updatePayload.signedAgreementStoragePath = filePath;
                      updatePayload.signedAgreementUrl = urlData?.publicUrl || null;
                      console.log("[DIGIO WEBHOOK] Signed agreement stored in Supabase");
                    } else {
                      console.error("[DIGIO WEBHOOK] Supabase upload error (signed):", upErr.message);
                    }
                  } else {
                    console.warn("[DIGIO WEBHOOK] Signed agreement PDF too small, skipping:", pdfBuffer.byteLength);
                  }
                } else {
                  const text = await signedRes.text();
                  console.warn("[DIGIO WEBHOOK] Signed agreement response not PDF:", contentType, text.slice(0, 200));
                }
              } else {
                console.warn("[DIGIO WEBHOOK] Digio signed agreement download failed:", signedRes.status);
              }
            } catch (e) {
              console.error("[DIGIO WEBHOOK] Signed agreement fetch error:", e);
            }
          }

          // Fetch audit trail PDF from Digio
          if (!auditTrailUrl) {
            try {
              const auditRes = await fetch(
                `${digioBaseUrl}/v2/client/document/download_audit_trail?document_id=${docId}`,
                { method: "GET", headers: { Authorization: digioAuth, Accept: "application/pdf" }, cache: "no-store" }
              );

              if (auditRes.ok) {
                const contentType = auditRes.headers.get("content-type") || "";
                if (contentType.includes("pdf") || contentType.includes("octet-stream")) {
                  const pdfBuffer = await auditRes.arrayBuffer();
                  if (pdfBuffer.byteLength > 100) {
                    const filePath = `agreements/${application.id}/audit-trail.pdf`;
                    const { error: upErr } = await supabase.storage
                      .from(bucketName)
                      .upload(filePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

                    if (!upErr) {
                      const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(filePath);
                      updatePayload.auditTrailStoragePath = filePath;
                      updatePayload.auditTrailUrl = urlData?.publicUrl || null;
                      console.log("[DIGIO WEBHOOK] Audit trail stored in Supabase");
                    } else {
                      console.error("[DIGIO WEBHOOK] Supabase upload error (audit):", upErr.message);
                    }
                  } else {
                    console.warn("[DIGIO WEBHOOK] Audit trail PDF too small, skipping:", pdfBuffer.byteLength);
                  }
                } else {
                  const text = await auditRes.text();
                  console.warn("[DIGIO WEBHOOK] Audit trail response not PDF:", contentType, text.slice(0, 200));
                }
              } else {
                console.warn("[DIGIO WEBHOOK] Digio audit trail download failed:", auditRes.status);
              }
            } catch (e) {
              console.error("[DIGIO WEBHOOK] Audit trail fetch error:", e);
            }
          }
        }
      } catch (e) {
        console.error("[DIGIO WEBHOOK] AUTO FETCH ERROR:", e);
      }
    }

    // Failed
    if (agreementStatus === "failed") {
      updatePayload.reviewStatus = "pending_admin_review";
      updatePayload.completionStatus = "pending";
      updatePayload.agreementFailedAt = new Date();
      updatePayload.agreementFailureReason = failureReason;
    }

    // Expired
    if (agreementStatus === "expired") {
      updatePayload.reviewStatus = "pending_admin_review";
      updatePayload.completionStatus = "pending";
      updatePayload.agreementExpiredAt = new Date();
    }

    await db
      .update(dealerOnboardingApplications)
      .set(updatePayload)
      .where(eq(dealerOnboardingApplications.id, application.id));

    // Update signer rows
    const signingParties = Array.isArray(body?.signing_parties)
      ? body.signing_parties
      : [];

    const existingSigners = await db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.applicationId, application.id));

    for (const party of signingParties) {
      const identifier = cleanString(
        party?.identifier || party?.email || party?.mobile || ""
      );

      if (!identifier) continue;

      const matchedSigner = existingSigners.find((row) => {
        return (
          cleanString(row.providerSignerIdentifier || "").toLowerCase() ===
            identifier.toLowerCase() ||
          cleanString(row.signerEmail || "").toLowerCase() ===
            identifier.toLowerCase() ||
          cleanString(row.signerMobile || "") === identifier
        );
      });

      if (!matchedSigner) continue;

      const signerStatus = mapDigioSignerStatus(party?.status);

      await db
        .update(dealerAgreementSigners)
        .set({
          signerStatus,
          providerSigningUrl:
            party?.authentication_url ||
            party?.authenticationUrl ||
            matchedSigner.providerSigningUrl,
          providerRawResponse: party || {},
          signedAt:
            signerStatus === "signed"
              ? matchedSigner.signedAt || new Date()
              : matchedSigner.signedAt,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dealerAgreementSigners.id, matchedSigner.id));
    }

    await insertAgreementEvent({
      applicationId: application.id,
      providerDocumentId: documentId || application.providerDocumentId || null,
      requestId: requestId || application.requestId || null,
      eventType: agreementStatus,
      eventStatus: agreementStatus,
      eventPayload: body,
    });

    return NextResponse.json({
      success: true,
      agreementStatus,
      signedAgreementUrl,
      auditTrailUrl,
    });
  } catch (error: any) {
    console.error("DIGIO WEBHOOK ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}