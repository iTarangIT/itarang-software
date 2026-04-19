import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminKycReviews,
  adminVerificationQueue,
  coBorrowerDocuments,
  coBorrowerRequests,
  coBorrowers,
  consentRecords,
  leads,
  digilockerTransactions,
  kycDocuments,
  kycVerificationMetadata,
  kycVerifications,
  otherDocumentRequests,
  personalDetails,
} from "@/lib/db/schema";
import {
  calculateQueuePriority,
  formatSlaAge,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";

function formatDob(dob: Date | string | null | undefined): string | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;

    // Parallel fetch all case data (primary + Step 3 supporting docs + co-borrower)
    const [
      leadRows,
      personalRows,
      documents,
      verifications,
      consentRows,
      metadataRows,
      queueRows,
      reviewRows,
      digilockerRows,
      supportingDocsRows,
      coBorrowerRows,
      coBorrowerDocRows,
      coBorrowerRequestRows,
    ] = await Promise.all([
      db
        .select()
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1),
      db
        .select()
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1),
      db
        .select()
        .from(kycDocuments)
        .where(eq(kycDocuments.lead_id, leadId))
        .orderBy(kycDocuments.uploaded_at),
      db
        .select()
        .from(kycVerifications)
        .where(eq(kycVerifications.lead_id, leadId))
        .orderBy(kycVerifications.created_at),
      db
        .select()
        .from(consentRecords)
        .where(eq(consentRecords.lead_id, leadId))
        .orderBy(desc(consentRecords.created_at)),
      db
        .select()
        .from(kycVerificationMetadata)
        .where(eq(kycVerificationMetadata.lead_id, leadId))
        .limit(1),
      db
        .select()
        .from(adminVerificationQueue)
        .where(eq(adminVerificationQueue.lead_id, leadId))
        .orderBy(desc(adminVerificationQueue.created_at))
        .limit(1),
      db
        .select()
        .from(adminKycReviews)
        .where(eq(adminKycReviews.lead_id, leadId))
        .orderBy(desc(adminKycReviews.reviewed_at)),
      db
        .select()
        .from(digilockerTransactions)
        .where(eq(digilockerTransactions.lead_id, leadId))
        .orderBy(desc(digilockerTransactions.created_at)),
      db
        .select()
        .from(otherDocumentRequests)
        .where(eq(otherDocumentRequests.lead_id, leadId))
        .orderBy(desc(otherDocumentRequests.created_at)),
      db
        .select()
        .from(coBorrowers)
        .where(eq(coBorrowers.lead_id, leadId))
        .limit(1),
      db
        .select()
        .from(coBorrowerDocuments)
        .where(eq(coBorrowerDocuments.lead_id, leadId))
        .orderBy(coBorrowerDocuments.uploaded_at),
      db
        .select()
        .from(coBorrowerRequests)
        .where(eq(coBorrowerRequests.lead_id, leadId))
        .orderBy(desc(coBorrowerRequests.attempt_number)),
    ]);

    const lead = leadRows[0];
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const personal = personalRows[0] || null;
    const metadata = metadataRows[0] || null;
    const queueEntry = queueRows[0] || null;
    const coBorrower = coBorrowerRows[0] || null;
    const activeCoBorrowerRequest =
      coBorrowerRequestRows.find((r) => r.status === "open") ||
      coBorrowerRequestRows[0] ||
      null;

    const mapVerification = (v: typeof verifications[number]) => ({
      id: v.id,
      type: v.verification_type,
      applicant: v.applicant,
      status: v.status,
      provider: v.api_provider,
      matchScore: v.match_score,
      failedReason: v.failed_reason,
      retryCount: v.retry_count,
      adminAction: v.admin_action,
      adminActionNotes: v.admin_action_notes,
      submittedAt: v.submitted_at,
      completedAt: v.completed_at,
      apiRequest: v.api_request,
      apiResponse: v.api_response,
    });

    // Split verifications by applicant. Rows without an applicant column
    // (backfill default) count as primary.
    const verificationCards = verifications
      .filter((v) => (v.applicant ?? "primary") === "primary")
      .map(mapVerification);

    const coBorrowerVerificationCards = verifications
      .filter((v) => v.applicant === "co_borrower")
      .map(mapVerification);

    // SLA and priority for queue entry
    const sla = queueEntry?.created_at
      ? formatSlaAge(queueEntry.created_at)
      : null;
    const priority = queueEntry?.created_at
      ? calculateQueuePriority({
          createdAt: queueEntry.created_at,
          status: queueEntry.status,
        })
      : "normal";

    return NextResponse.json({
      success: true,
      data: {
        lead: {
          id: lead.id,
          name: lead.full_name || lead.owner_name || "",
          phone: lead.phone || lead.mobile || lead.owner_contact || "",
          shopName: lead.business_name || "",
          location: lead.city
            ? `${lead.city}${lead.state ? ", " + lead.state : ""}`
            : lead.shop_address || "",
          currentStatus: lead.status || lead.kyc_status || "",
        },
        personalDetails: personal
          ? {
              aadhaarNo: personal.aadhaar_no,
              panNo: personal.pan_no,
              dob: formatDob(personal.dob || lead.dob),
              email: personal.email || lead.owner_email,
              fatherHusbandName:
                personal.father_husband_name || lead.father_or_husband_name,
              localAddress:
                personal.local_address || lead.local_address || lead.current_address,
              vehicleRc: personal.vehicle_rc || lead.vehicle_rc,
              financeType: personal.finance_type,
              financier: personal.financier,
              assetType: personal.asset_type,
            }
          : {
              aadhaarNo: null,
              panNo: null,
              dob: formatDob(lead.dob),
              email: lead.owner_email,
              fatherHusbandName: lead.father_or_husband_name,
              localAddress: lead.local_address || lead.current_address,
              vehicleRc: lead.vehicle_rc,
              financeType: null,
              financier: null,
              assetType: null,
            },
        documents: documents.map((d) => ({
          id: d.id,
          docType: d.doc_type,
          fileUrl: d.file_url,
          fileName: d.file_name,
          verificationStatus: d.verification_status,
          ocrData: d.ocr_data,
          uploadedAt: d.uploaded_at,
        })),
        verificationCards,
        consent: await Promise.all(consentRows.map(async (c) => {
          let signedUrl = c.signed_consent_url;

          // Auto-fetch signed PDF from DigiO if consent is completed but PDF is missing
          if (
            !signedUrl &&
            c.esign_transaction_id &&
            ['esign_completed', 'admin_review_pending'].includes(c.consent_status)
          ) {
            try {
              const stored = await fetchAndStoreSignedConsent(c.esign_transaction_id, leadId);
              if (stored?.publicUrl) {
                signedUrl = stored.publicUrl;
                // Persist so we don't fetch again
                await db.update(consentRecords)
                  .set({ signed_consent_url: signedUrl, updated_at: new Date() })
                  .where(eq(consentRecords.id, c.id));
              }
            } catch (e) {
              console.error("[Case Review] Failed to auto-fetch signed consent PDF:", e);
            }
          }

          return {
            id: c.id,
            consentFor: c.consent_for,
            consentType: c.consent_type,
            consentStatus: c.consent_status,
            generatedPdfUrl: c.generated_pdf_url,
            signedConsentUrl: signedUrl,
            signedAt: c.signed_at,
            verifiedAt: c.verified_at,
            adminViewedBy: c.admin_viewed_by,
            adminViewedAt: c.admin_viewed_at,
          };
        })),
        metadata: metadata
          ? {
              caseType: metadata.case_type,
              couponCode: metadata.coupon_code,
              couponStatus: metadata.coupon_status,
              documentsCount: metadata.documents_count,
              consentVerified: metadata.consent_verified,
              dealerEditsLocked: metadata.dealer_edits_locked,
              submissionTimestamp: metadata.submission_timestamp,
              verificationStartedAt: metadata.verification_started_at,
              firstApiExecutionAt: metadata.first_api_execution_at,
              firstApiType: metadata.first_api_type,
              finalDecision: metadata.final_decision,
              finalDecisionAt: metadata.final_decision_at,
            }
          : null,
        queueEntry: queueEntry
          ? {
              id: queueEntry.id,
              status: queueEntry.status,
              priority,
              assignedTo: queueEntry.assigned_to,
              submittedAt: queueEntry.submitted_at,
              reviewedAt: queueEntry.reviewed_at,
              slaAge: sla,
            }
          : null,
        reviews: reviewRows.map((r) => ({
          id: r.id,
          documentId: r.document_id,
          documentType: r.document_type,
          reviewFor: r.review_for,
          outcome: r.outcome,
          rejectionReason: r.rejection_reason,
          reviewerNotes: r.reviewer_notes,
          reviewedAt: r.reviewed_at,
        })),
        digilocker: digilockerRows.map((d) => ({
          id: d.id,
          status: d.status,
          sessionId: d.session_id,
          linkSentAt: d.link_sent_at,
          customerAuthorizedAt: d.customer_authorized_at,
          aadhaarExtractedData: d.aadhaar_extracted_data,
          crossMatchResult: d.cross_match_result,
          expiresAt: d.expires_at,
        })),
        supportingDocs: supportingDocsRows.map((r) => ({
          id: r.id,
          docFor: r.doc_for,
          docLabel: r.doc_label,
          docKey: r.doc_key,
          isRequired: r.is_required,
          fileUrl: r.file_url,
          uploadStatus: r.upload_status,
          rejectionReason: r.rejection_reason,
          requestedAt: r.created_at,
          uploadedAt: r.uploaded_at,
          reviewedAt: r.reviewed_at,
          uploadToken: r.upload_token,
          tokenExpiresAt: r.token_expires_at,
        })),
        coBorrower: coBorrower
          ? {
              id: coBorrower.id,
              fullName: coBorrower.full_name,
              fatherOrHusbandName: coBorrower.father_or_husband_name,
              dob: formatDob(coBorrower.dob),
              phone: coBorrower.phone,
              permanentAddress: coBorrower.permanent_address,
              currentAddress: coBorrower.current_address,
              isCurrentSame: coBorrower.is_current_same,
              panNo: coBorrower.pan_no,
              aadhaarNo: coBorrower.aadhaar_no,
              kycStatus: coBorrower.kyc_status,
              consentStatus: coBorrower.consent_status,
              verificationSubmittedAt: coBorrower.verification_submitted_at,
              documents: coBorrowerDocRows.map((d) => ({
                id: d.id,
                docType: d.doc_type,
                fileUrl: d.file_url,
                status: d.status,
                ocrData: d.ocr_data,
                uploadedAt: d.uploaded_at,
              })),
              verificationCards: coBorrowerVerificationCards,
              activeRequest: activeCoBorrowerRequest
                ? {
                    id: activeCoBorrowerRequest.id,
                    attemptNumber: activeCoBorrowerRequest.attempt_number,
                    reason: activeCoBorrowerRequest.reason,
                    status: activeCoBorrowerRequest.status,
                    createdAt: activeCoBorrowerRequest.created_at,
                  }
                : null,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("[Admin Case Review] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch case review";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
