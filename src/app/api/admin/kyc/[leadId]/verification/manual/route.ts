import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, kycVerifications } from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";
import { notifyKycCardAction } from "@/lib/notifications";

// Manual override endpoint. Lets admins accept / reject a KYC card without
// running the underlying API verification — we create a kyc_verifications row
// (or update an existing one) directly in the terminal admin state so the
// rest of the workflow (Step 3 approval gates, audit trail) keeps working
// uniformly.
const VALID_ACTIONS = ["accept", "reject"] as const;
type ManualAction = (typeof VALID_ACTIONS)[number];

const VALID_TYPES = [
  "aadhaar",
  "pan",
  "bank",
  "rc",
  "cibil",
  "address",
  "mobile",
  "photo",
] as const;
const VALID_APPLICANTS = ["primary", "co_borrower"] as const;

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

    const action =
      typeof body.action === "string" ? (body.action.trim() as ManualAction) : ("" as ManualAction);
    const verificationType =
      typeof body.verification_type === "string"
        ? body.verification_type.trim()
        : "";
    const applicant =
      typeof body.applicant === "string" ? body.applicant.trim() : "primary";
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
    if (!VALID_TYPES.includes(verificationType as (typeof VALID_TYPES)[number])) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `verification_type must be one of: ${VALID_TYPES.join(", ")}`,
          },
        },
        { status: 400 },
      );
    }
    if (!VALID_APPLICANTS.includes(applicant as (typeof VALID_APPLICANTS)[number])) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `applicant must be one of: ${VALID_APPLICANTS.join(", ")}`,
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

    // If a row already exists for this (lead, type, applicant) we update it
    // rather than inserting a duplicate — admins may flip a previously-failed
    // verification to a manual override.
    const existing = await db
      .select()
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, verificationType),
          eq(kycVerifications.applicant, applicant),
        ),
      )
      .limit(1);

    const now = new Date();
    const newStatus = action === "accept" ? "success" : "failed";
    const adminAction = action === "accept" ? "accepted" : "rejected";
    const manualMarker = {
      manual: true,
      reason: "Admin manual decision (API verification not run)",
    };

    let verificationId: string;
    if (existing[0]) {
      verificationId = existing[0].id;
      await db
        .update(kycVerifications)
        .set({
          status: newStatus,
          admin_action: adminAction,
          admin_action_by: appUser.id,
          admin_action_at: now,
          admin_action_notes: notes || rejectionReason,
          failed_reason:
            action === "reject" ? rejectionReason : existing[0].failed_reason,
          completed_at: action === "accept" ? now : existing[0].completed_at,
          updated_at: now,
        })
        .where(eq(kycVerifications.id, verificationId));
    } else {
      verificationId = createWorkflowId("KYCVER", now);
      await db.insert(kycVerifications).values({
        id: verificationId,
        lead_id: leadId,
        verification_type: verificationType,
        applicant,
        status: newStatus,
        api_response: manualMarker,
        failed_reason: action === "reject" ? rejectionReason : null,
        submitted_at: now,
        completed_at: action === "accept" ? now : null,
        admin_action: adminAction,
        admin_action_by: appUser.id,
        admin_action_at: now,
        admin_action_notes: notes || rejectionReason,
        created_at: now,
        updated_at: now,
      });
    }

    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "kyc_verification",
      entity_id: verificationId,
      action: `card_manual_${action}`,
      changes: {
        lead_id: leadId,
        verification_type: verificationType,
        applicant,
        admin_action: adminAction,
        notes,
        rejection_reason: rejectionReason,
        manual: true,
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    notifyKycCardAction({
      leadId,
      verificationType,
      action: adminAction,
      notes: notes || rejectionReason,
      adminId: appUser.id,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        verificationId,
        verificationType,
        applicant,
        action: adminAction,
        updatedStatus: newStatus,
        manual: true,
      },
    });
  } catch (error) {
    console.error("[Manual Verification Action] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to process manual verification action";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
