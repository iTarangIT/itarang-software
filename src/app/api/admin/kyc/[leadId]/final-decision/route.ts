import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import {
  applyKycFinalDecision,
  messageForDecision,
  VALID_DECISIONS,
  type KycDecision,
} from "@/lib/kyc/final-decision";

// BRD §2.9.3 Panel 4 "Step 3 Final Decision Panel".
//
// The decision itself — the approve gate, the lead-status derivation and every
// database write — lives in `@/lib/kyc/final-decision`. It was lifted out in
// E-246 so the KYC auto-approval SLA sweep runs exactly this logic instead of a
// second copy of it; this route is now auth, body parsing and HTTP shaping.

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
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const rejectionReason =
      typeof body.rejection_reason === "string"
        ? body.rejection_reason.trim()
        : null;

    if (!VALID_DECISIONS.includes(decisionRaw as KycDecision)) {
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
    const decision = decisionRaw as KycDecision;

    const result = await applyKycFinalDecision({
      leadId,
      decision,
      notes,
      rejectionReason,
      actor: { id: appUser.id, source: "admin" },
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Cannot approve. Resolve these first:\n• ${result.blockers.join("\n• ")}`,
            blockers: result.blockers,
          },
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        leadId,
        decision,
        leadStatus: result.leadStatus,
        couponConsumed: result.couponConsumed,
        couponCode: result.couponCode,
        message: messageForDecision(decision, result.leadStatus),
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
