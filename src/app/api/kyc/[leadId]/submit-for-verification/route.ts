import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  dealerLeads,
  kycDocuments,
  kycVerificationMetadata,
} from "@/lib/db/schema";
import {
  ADMIN_KYC_OPEN_STATUSES,
  buildDealerEditLockMessage,
  createWorkflowId,
  determineCaseType,
  getOpenQueueEntryForLead,
  getReservedCouponForLead,
  isConsentCompleted,
  requireDealerAppUser,
  requiredDocumentCount,
} from "@/lib/kyc/admin-workflow";

const DEFAULT_ESTIMATED_REVIEW_TIME = "10-12 hours";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireDealerAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 },
      );
    }

    const { leadId } = await params;

    const leadRows = await db
      .select({
        id: dealerLeads.id,
        dealer_name: dealerLeads.dealer_name,
        phone: dealerLeads.phone,
        shop_name: dealerLeads.shop_name,
        current_status: dealerLeads.current_status,
      })
      .from(dealerLeads)
      .where(eq(dealerLeads.id, leadId))
      .limit(1);

    const lead = leadRows[0];
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const existingOpenEntry = await getOpenQueueEntryForLead(leadId);
    if (existingOpenEntry) {
      const queueRows = await db
        .select({ id: adminVerificationQueue.id })
        .from(adminVerificationQueue)
        .where(
          inArray(
            adminVerificationQueue.status,
            ADMIN_KYC_OPEN_STATUSES as unknown as string[],
          ),
        )
        .orderBy(adminVerificationQueue.created_at);

      const queuePosition =
        queueRows.findIndex((row) => row.id === existingOpenEntry.id) + 1;

      return NextResponse.json({
        success: true,
        leadStatus: existingOpenEntry.status,
        queuePosition: queuePosition > 0 ? queuePosition : 1,
        estimatedReviewTime: DEFAULT_ESTIMATED_REVIEW_TIME,
        message: "Case already submitted to iTarang verification team",
      });
    }

    const [documentRows, consentVerified, couponData, queueCountRows] =
      await Promise.all([
        db
          .select({
            id: kycDocuments.id,
            doc_type: kycDocuments.doc_type,
          })
          .from(kycDocuments)
          .where(eq(kycDocuments.lead_id, leadId)),
        isConsentCompleted(leadId),
        getReservedCouponForLead(leadId),
        db
          .select({ count: sql<number>`count(*)` })
          .from(adminVerificationQueue)
          .where(
            inArray(
              adminVerificationQueue.status,
              ADMIN_KYC_OPEN_STATUSES as unknown as string[],
            ),
          ),
      ]);

    const documentsCount = documentRows.length;
    const caseType = determineCaseType({
      paymentMethod: couponData.paymentMethod,
      documentsCount,
    });
    const requiredDocs = requiredDocumentCount(caseType);

    if (!consentVerified) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "Customer consent must be completed before submission for verification",
          },
        },
        { status: 400 },
      );
    }

    if (documentsCount < requiredDocs) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `All required documents must be uploaded before submission (${documentsCount}/${requiredDocs})`,
          },
        },
        { status: 400 },
      );
    }

    if (!couponData.couponCode || couponData.couponStatus !== "validated") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "A reserved verification coupon is required before submission",
          },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const queueId = createWorkflowId("ADMQ", now);
    const openQueueCount = Number(queueCountRows[0]?.count ?? 0);
    const queuePosition = openQueueCount + 1;

    await db.transaction(async (tx) => {
      await tx.insert(adminVerificationQueue).values({
        id: queueId,
        queue_type: "kyc_verification",
        lead_id: leadId,
        priority: "normal",
        assigned_to: null,
        submitted_by: appUser.id,
        status: "pending_itarang_verification",
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });

      const metadataRows = await tx
        .select({ lead_id: kycVerificationMetadata.lead_id })
        .from(kycVerificationMetadata)
        .where(eq(kycVerificationMetadata.lead_id, leadId))
        .limit(1);

      const metadataPayload = {
        submission_timestamp: now,
        case_type: caseType,
        coupon_code: couponData.couponCode,
        coupon_status: "reserved",
        documents_count: documentsCount,
        consent_verified: true,
        dealer_edits_locked: true,
        updated_at: now,
      };

      if (metadataRows.length > 0) {
        await tx
          .update(kycVerificationMetadata)
          .set(metadataPayload)
          .where(eq(kycVerificationMetadata.lead_id, leadId));
      } else {
        await tx.insert(kycVerificationMetadata).values({
          lead_id: leadId,
          ...metadataPayload,
          created_at: now,
        });
      }

      await tx
        .update(dealerLeads)
        .set({
          current_status: "pending_itarang_verification",
        })
        .where(eq(dealerLeads.id, leadId));
    });

    return NextResponse.json({
      success: true,
      leadStatus: "pending_itarang_verification",
      queuePosition,
      estimatedReviewTime: DEFAULT_ESTIMATED_REVIEW_TIME,
      message: "Case submitted to iTarang verification team",
      data: {
        queueId,
        leadId: lead.id,
        customerName: lead.dealer_name ?? "Unknown",
        dealerName: lead.shop_name ?? "Unknown Dealer",
        couponCode: couponData.couponCode,
        caseType,
        dealerEditsLocked: true,
        lockMessage: buildDealerEditLockMessage(),
      },
    });
  } catch (error) {
    console.error("[Submit For Verification] Error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to submit case";

    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
