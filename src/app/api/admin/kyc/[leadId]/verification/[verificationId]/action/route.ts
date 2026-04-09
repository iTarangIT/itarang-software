import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, kycVerifications } from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

const VALID_ACTIONS = ["accept", "reject", "request_more_docs"] as const;
type CardAction = (typeof VALID_ACTIONS)[number];

const ACTION_TO_STATUS: Record<CardAction, string> = {
  accept: "success",
  reject: "failed",
  request_more_docs: "awaiting_action",
};

const ACTION_TO_ADMIN_ACTION: Record<CardAction, string> = {
  accept: "accepted",
  reject: "rejected",
  request_more_docs: "request_more_docs",
};

export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; verificationId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, verificationId } = await params;
    const body = await req.json();

    const action =
      typeof body.action === "string"
        ? (body.action.trim() as CardAction)
        : ("" as CardAction);
    const notes =
      typeof body.notes === "string" ? body.notes.trim() : null;
    const rejectionReason =
      typeof body.rejection_reason === "string"
        ? body.rejection_reason.trim()
        : null;

    if (!VALID_ACTIONS.includes(action)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
          },
        },
        { status: 400 },
      );
    }

    if (action === "reject" && !rejectionReason) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "rejection_reason is required when rejecting" },
        },
        { status: 400 },
      );
    }

    // Fetch the verification record
    const verRows = await db
      .select()
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.id, verificationId),
          eq(kycVerifications.lead_id, leadId),
        ),
      )
      .limit(1);

    const verification = verRows[0];
    if (!verification) {
      return NextResponse.json(
        { success: false, error: { message: "Verification not found" } },
        { status: 404 },
      );
    }

    const now = new Date();
    const newStatus = ACTION_TO_STATUS[action];
    const adminAction = ACTION_TO_ADMIN_ACTION[action];

    // Update verification
    await db
      .update(kycVerifications)
      .set({
        status: newStatus,
        admin_action: adminAction,
        admin_action_by: appUser.id,
        admin_action_at: now,
        admin_action_notes: notes || rejectionReason,
        failed_reason:
          action === "reject" ? rejectionReason : verification.failed_reason,
        completed_at: action === "accept" ? now : verification.completed_at,
        updated_at: now,
      })
      .where(eq(kycVerifications.id, verificationId));

    // Audit log
    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "kyc_verification",
      entity_id: verificationId,
      action: `card_${action}`,
      changes: {
        lead_id: leadId,
        verification_type: verification.verification_type,
        previous_status: verification.status,
        new_status: newStatus,
        admin_action: adminAction,
        notes,
        rejection_reason: rejectionReason,
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    return NextResponse.json({
      success: true,
      data: {
        verificationId,
        verificationType: verification.verification_type,
        action: adminAction,
        updatedStatus: newStatus,
      },
    });
  } catch (error) {
    console.error("[Verification Card Action] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to process verification action";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
