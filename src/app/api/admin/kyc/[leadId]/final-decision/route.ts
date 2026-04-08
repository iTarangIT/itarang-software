import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  auditLogs,
  couponCodes,
  dealerLeads,
  kycVerificationMetadata,
} from "@/lib/db/schema";
import {
  ADMIN_KYC_OPEN_STATUSES,
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

const VALID_DECISIONS = ["approved", "rejected"] as const;

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

    const decision =
      typeof body.decision === "string" ? body.decision.trim() : "";
    const notes =
      typeof body.notes === "string" ? body.notes.trim() : null;
    const rejectionReason =
      typeof body.rejection_reason === "string"
        ? body.rejection_reason.trim()
        : null;

    if (
      !VALID_DECISIONS.includes(
        decision as (typeof VALID_DECISIONS)[number],
      )
    ) {
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

    const queueEntry = queueRows[0];
    if (!queueEntry) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "No open verification queue entry found for this lead",
          },
        },
        { status: 404 },
      );
    }

    // Fetch metadata to get coupon code
    const metadataRows = await db
      .select()
      .from(kycVerificationMetadata)
      .where(eq(kycVerificationMetadata.lead_id, leadId))
      .limit(1);

    const metadata = metadataRows[0];
    const now = new Date();
    let couponConsumed = false;

    await db.transaction(async (tx) => {
      // 1. Update queue entry
      await tx
        .update(adminVerificationQueue)
        .set({
          status: decision,
          reviewed_at: now,
          updated_at: now,
        })
        .where(eq(adminVerificationQueue.id, queueEntry.id));

      // 2. Update metadata
      if (metadata) {
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
      }

      // 3. If approved, consume coupon
      if (decision === "approved" && metadata?.coupon_code) {
        await tx
          .update(couponCodes)
          .set({
            status: "used",
            used_at: now,
          })
          .where(eq(couponCodes.code, metadata.coupon_code));

        if (metadata) {
          await tx
            .update(kycVerificationMetadata)
            .set({ coupon_status: "used", updated_at: now })
            .where(eq(kycVerificationMetadata.lead_id, leadId));
        }

        couponConsumed = true;
      }

      // 4. If rejected, unlock dealer edits
      if (decision === "rejected" && metadata) {
        await tx
          .update(kycVerificationMetadata)
          .set({ dealer_edits_locked: false, updated_at: now })
          .where(eq(kycVerificationMetadata.lead_id, leadId));
      }

      // 5. Update lead status
      const leadStatus =
        decision === "approved" ? "kyc_approved" : "kyc_rejected";
      await tx
        .update(dealerLeads)
        .set({ current_status: leadStatus })
        .where(eq(dealerLeads.id, leadId));

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
          notes,
          rejection_reason: rejectionReason,
          coupon_consumed: couponConsumed,
          coupon_code: metadata?.coupon_code,
        },
        performed_by: appUser.id,
        timestamp: now,
      });
    });

    return NextResponse.json({
      success: true,
      data: {
        leadId,
        decision,
        couponConsumed,
        couponCode: metadata?.coupon_code || null,
        message:
          decision === "approved"
            ? "KYC verification approved successfully"
            : "KYC verification rejected",
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
