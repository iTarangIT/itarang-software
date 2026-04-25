import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  auditLogs,
  coBorrowerRequests,
  coBorrowers,
  couponCodes,
  kycVerifications,
  leads,
  kycVerificationMetadata,
  otherDocumentRequests,
} from "@/lib/db/schema";
import {
  ADMIN_KYC_OPEN_STATUSES,
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";
import {
  notifyKycFinalDecision,
  notifyStep3DealerActionRequired,
} from "@/lib/notifications";

// BRD §2.9.3 Panel 4 "Step 3 Final Decision Panel" — three actions:
//   1. approved            → step_3_cleared, unlock Step 4
//   2. rejected            → kyc_rejected, lead closed
//   3. dealer_action_required → one of awaiting_additional_docs /
//      awaiting_co_borrower_kyc / awaiting_co_borrower_replacement /
//      awaiting_doc_reupload / awaiting_both (computed from card states)

const VALID_DECISIONS = [
  "approved",
  "rejected",
  "dealer_action_required",
] as const;

type Decision = (typeof VALID_DECISIONS)[number];

export async function POST(
  req: NextRequest,
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
    const body = await req.json();

    const decisionRaw =
      typeof body.decision === "string" ? body.decision.trim() : "";
    const notes =
      typeof body.notes === "string" ? body.notes.trim() : null;
    const rejectionReason =
      typeof body.rejection_reason === "string"
        ? body.rejection_reason.trim()
        : null;

    if (!VALID_DECISIONS.includes(decisionRaw as Decision)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `decision must be one of: ${VALID_DECISIONS.join(", ")}`,
          },
        },
        { status: 400 },
      );
    }
    const decision = decisionRaw as Decision;

    if (decision === "rejected" && !rejectionReason) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "rejection_reason is required when rejecting",
          },
        },
        { status: 400 },
      );
    }

    // For approved / dealer_action_required we also need the Step 3 state so
    // we can gate the Approve button and compute the correct awaiting status.
    const [step3SupportingDocs, step3CoBorrower, step3Verifications] =
      await Promise.all([
        db
          .select()
          .from(otherDocumentRequests)
          .where(eq(otherDocumentRequests.lead_id, leadId)),
        db
          .select()
          .from(coBorrowers)
          .where(eq(coBorrowers.lead_id, leadId))
          .limit(1),
        db
          .select()
          .from(kycVerifications)
          .where(eq(kycVerifications.lead_id, leadId)),
      ]);

    const hasOpenSupportingDoc = step3SupportingDocs.some(
      (d) => d.upload_status !== "verified",
    );
    const hasRejectedSupportingDoc = step3SupportingDocs.some(
      (d) => d.upload_status === "rejected",
    );
    const hasCoBorrower = !!step3CoBorrower[0];
    const coBorrowerCibilVer = step3Verifications.find(
      (v) => v.applicant === "co_borrower" && v.verification_type === "cibil",
    );
    const coBorrowerIdentityVer = step3Verifications.find(
      (v) =>
        v.applicant === "co_borrower" &&
        (v.verification_type === "aadhaar" || v.verification_type === "pan"),
    );
    const coBorrowerRejectedByIdentity =
      coBorrowerCibilVer?.admin_action === "rejected" ||
      coBorrowerIdentityVer?.admin_action === "rejected";
    const coBorrowerAllApproved =
      hasCoBorrower &&
      step3Verifications
        .filter((v) => v.applicant === "co_borrower")
        .every((v) => v.admin_action === "accepted");

    const allPrimaryApproved = step3Verifications
      .filter((v) => (v.applicant ?? "primary") === "primary")
      .every((v) => v.admin_action === "accepted");

    const allPrimaryRejected =
      step3Verifications.filter((v) => (v.applicant ?? "primary") === "primary")
        .length > 0 &&
      step3Verifications
        .filter((v) => (v.applicant ?? "primary") === "primary")
        .every((v) => v.admin_action === "rejected");

    const allSupportingDocsRejected = step3SupportingDocs.every(
      (d) => d.upload_status === "rejected",
    );

    const coBorrowerAllRejected =
      hasCoBorrower &&
      step3Verifications
        .filter((v) => v.applicant === "co_borrower")
        .every((v) => v.admin_action === "rejected");

    if (decision === "approved") {
      const approvable =
        allPrimaryApproved &&
        !hasOpenSupportingDoc &&
        (!hasCoBorrower || coBorrowerAllApproved);
      if (!approvable) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message:
                "Cannot approve: every verification, supporting doc, and co-borrower check must be approved.",
            },
          },
          { status: 400 },
        );
      }
    }

    if (decision === "rejected") {
      const rejectable =
        allPrimaryRejected &&
        allSupportingDocsRejected &&
        (!hasCoBorrower || coBorrowerAllRejected);
      if (!rejectable) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message:
                "Cannot reject: every verification, supporting doc, and co-borrower check must be rejected.",
            },
          },
          { status: 400 },
        );
      }
    }

    // Find open queue entry
    const queueRows = await db
      .select()
      .from(adminVerificationQueue)
      .where(
        and(
          eq(adminVerificationQueue.lead_id, leadId),
          inArray(
            adminVerificationQueue.status,
            ADMIN_KYC_OPEN_STATUSES as unknown as string[],
          ),
        ),
      )
      .limit(1);

    let queueEntry = queueRows[0];

    // Auto-create queue entry if admin is making a decision without a formal dealer submission
    if (!queueEntry) {
      const queueNow = new Date();
      const newId = createWorkflowId("ADMQ", queueNow);
      const inserted = await db.insert(adminVerificationQueue).values({
        id: newId,
        queue_type: "kyc_verification",
        lead_id: leadId,
        priority: "normal",
        assigned_to: appUser.id,
        submitted_by: appUser.id,
        status: "in_progress",
        submitted_at: queueNow,
        created_at: queueNow,
        updated_at: queueNow,
      }).returning();
      queueEntry = inserted[0];
    }

    // Fetch metadata to get coupon code
    const metadataRows = await db
      .select()
      .from(kycVerificationMetadata)
      .where(eq(kycVerificationMetadata.lead_id, leadId))
      .limit(1);

    let metadata = metadataRows[0];
    const now = new Date();
    let couponConsumed = false;

    // Auto-create metadata if it doesn't exist
    if (!metadata) {
      const inserted = await db
        .insert(kycVerificationMetadata)
        .values({
          lead_id: leadId,
          submission_timestamp: now,
          created_at: now,
          updated_at: now,
        })
        .returning();
      metadata = inserted[0];
    }

    // Compute the kyc_status to write on the leads row for each decision.
    // For Step 3 "Dealer Action Required" the exact awaiting_* code is
    // derived from which cards are in a rejected / request-docs state
    // (BRD line 2408).
    let leadStatus: string;
    if (decision === "approved") {
      // Step 3 path vs primary path — if there are any supporting docs or a
      // co-borrower row, this is a Step 3 approval and we write step_3_cleared
      // so Step 4 unlocks. Otherwise fall back to kyc_approved for the
      // primary-only path.
      leadStatus =
        hasCoBorrower || step3SupportingDocs.length > 0
          ? "step_3_cleared"
          : "kyc_approved";
    } else if (decision === "rejected") {
      leadStatus = "kyc_rejected";
    } else {
      // dealer_action_required — compute routing
      const supportingIssue = hasRejectedSupportingDoc || hasOpenSupportingDoc;
      const coBorrowerNeedsReplacement =
        hasCoBorrower && coBorrowerRejectedByIdentity;
      const coBorrowerNeedsRework =
        hasCoBorrower && !coBorrowerAllApproved && !coBorrowerRejectedByIdentity;

      if (supportingIssue && (coBorrowerNeedsRework || coBorrowerNeedsReplacement)) {
        leadStatus = "awaiting_both";
      } else if (coBorrowerNeedsReplacement) {
        leadStatus = "awaiting_co_borrower_replacement";
      } else if (coBorrowerNeedsRework) {
        leadStatus = "awaiting_co_borrower_kyc";
      } else if (hasRejectedSupportingDoc) {
        leadStatus = "awaiting_doc_reupload";
      } else if (supportingIssue) {
        leadStatus = "awaiting_additional_docs";
      } else {
        leadStatus = "awaiting_additional_docs";
      }
    }

    await db.transaction(async (tx) => {
      // 1. Update queue entry. BRD maps approved→step_3_cleared/kyc_approved
      // onto the queue's terminal "approved" status.
      const queueStatus =
        decision === "approved"
          ? "approved"
          : decision === "rejected"
            ? "rejected"
            : "requested_correction";

      await tx
        .update(adminVerificationQueue)
        .set({
          status: queueStatus,
          reviewed_at: now,
          updated_at: now,
        })
        .where(eq(adminVerificationQueue.id, queueEntry.id));

      // 2. Update metadata. dealer_edits_locked stays true for final approve
      // (so dealer can't mutate the case once Step 4 starts) and gets toggled
      // off for dealer_action_required / rejected so the dealer can edit.
      await tx
        .update(kycVerificationMetadata)
        .set({
          final_decision: decision,
          final_decision_at: now,
          final_decision_by: appUser.id,
          final_decision_notes: notes || rejectionReason,
          dealer_edits_locked: decision === "approved",
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));

      // 3. If approved, consume coupon
      if (decision === "approved" && metadata?.coupon_code) {
        await tx
          .update(couponCodes)
          .set({
            status: "used",
            used_at: now,
          })
          .where(eq(couponCodes.code, metadata.coupon_code));

        await tx
          .update(kycVerificationMetadata)
          .set({ coupon_status: "used", updated_at: now })
          .where(eq(kycVerificationMetadata.lead_id, leadId));

        couponConsumed = true;
      }

      // 4. Co-borrower replacement: increment attempt_number on an open
      // co_borrower_requests row when admin uses Dealer Action Required and
      // the co-borrower's identity/CIBIL was rejected (BRD line 2693).
      if (
        decision === "dealer_action_required" &&
        leadStatus === "awaiting_co_borrower_replacement"
      ) {
        const open = await tx
          .select()
          .from(coBorrowerRequests)
          .where(
            and(
              eq(coBorrowerRequests.lead_id, leadId),
              eq(coBorrowerRequests.status, "open"),
            ),
          )
          .orderBy(desc(coBorrowerRequests.attempt_number))
          .limit(1);
        if (open[0]) {
          await tx
            .update(coBorrowerRequests)
            .set({
              attempt_number: open[0].attempt_number + 1,
              reason: rejectionReason || open[0].reason,
              updated_at: now,
            })
            .where(eq(coBorrowerRequests.id, open[0].id));
        }
      }

      // 5. Update lead status
      await tx
        .update(leads)
        .set({ kyc_status: leadStatus, updated_at: now })
        .where(eq(leads.id, leadId));

      // 6. Audit log
      await tx.insert(auditLogs).values({
        id: createWorkflowId("AUDIT", now),
        entity_type: "kyc_final_decision",
        entity_id: leadId,
        action: decision,
        changes: {
          queue_id: queueEntry.id,
          previous_status: queueEntry.status,
          decision,
          lead_status: leadStatus,
          notes,
          rejection_reason: rejectionReason,
          coupon_consumed: couponConsumed,
          coupon_code: metadata?.coupon_code,
          has_co_borrower: hasCoBorrower,
          supporting_docs: step3SupportingDocs.length,
        },
        performed_by: appUser.id,
        timestamp: now,
      });
    });

    // Notify dealer on every terminal decision. The dashboard push helpers
    // each map to a specific notification type so the dealer UI can render
    // the correct banner (step_3_cleared vs kyc_approved_final vs action-required).
    if (decision === "approved" || decision === "rejected") {
      notifyKycFinalDecision({
        leadId,
        decision,
        notes,
        rejectionReason,
        adminId: appUser.id,
        leadStatus,
      }).catch(() => {});
    } else if (decision === "dealer_action_required") {
      notifyStep3DealerActionRequired({
        leadId,
        leadStatus,
        notes,
        rejectionReason,
      }).catch(() => {});
    }

    const messages: Record<Decision, string> = {
      approved:
        leadStatus === "step_3_cleared"
          ? "Step 3 cleared — Product Selection unlocked."
          : "KYC verification approved successfully.",
      rejected: "KYC verification rejected.",
      dealer_action_required: `Saved. Dealer must action items (${leadStatus.replace(/_/g, " ")}).`,
    };

    return NextResponse.json({
      success: true,
      data: {
        leadId,
        decision,
        leadStatus,
        couponConsumed,
        couponCode: metadata?.coupon_code || null,
        message: messages[decision],
      },
    });
  } catch (error) {
    console.error("[Final Decision] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to submit final decision";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
