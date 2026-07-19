import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionRounds,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

// Cancel (withdraw) an in-flight correction request. Mirrors apply-correction's
// state revert so the Approve gate behaves identically afterwards — the only
// difference is the round is closed as "cancelled" instead of "applied", and no
// dealer edits are merged. Marking the round non-open also invalidates the
// dealer's magic link (the correct/[token] route only serves pending/submitted
// rounds), so a cancelled request can no longer be filled in.
export async function POST(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [application] = await db
      .select({
        id: dealerOnboardingApplications.id,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        agreementStatus: dealerOnboardingApplications.agreement_status,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 },
      );
    }

    // The latest still-open round: "pending" (dealer hasn't responded yet) or
    // "submitted" (dealer responded, admin hasn't applied). Only these can be
    // cancelled; applied/superseded/cancelled rounds are already closed.
    const [openRound] = await db
      .select({
        id: dealerCorrectionRounds.id,
        roundNumber: dealerCorrectionRounds.round_number,
      })
      .from(dealerCorrectionRounds)
      .where(
        and(
          eq(dealerCorrectionRounds.application_id, dealerId),
          inArray(dealerCorrectionRounds.status, ["pending", "submitted"]),
        ),
      )
      .orderBy(desc(dealerCorrectionRounds.round_number))
      .limit(1);

    if (!openRound) {
      return NextResponse.json(
        {
          success: false,
          message: "There is no open correction request to cancel.",
        },
        { status: 409 },
      );
    }

    await db
      .update(dealerCorrectionRounds)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(eq(dealerCorrectionRounds.id, openRound.id));

    // A finance dealer that already has a completed agreement must keep
    // review_status = "agreement_completed" or the Approve gate would push them
    // back through signing. Everyone else returns to plain under_review.
    const agreementAlreadyComplete =
      !!application.financeEnabled &&
      (application.agreementStatus || "").toLowerCase() === "completed";

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboarding_status: "submitted",
        review_status: agreementAlreadyComplete
          ? "agreement_completed"
          : "under_review",
        completion_status: agreementAlreadyComplete ? "completed" : "pending",
        correction_remarks: null,
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    return NextResponse.json({
      success: true,
      message: "Correction request cancelled. The application is back under review.",
      cancelledRoundId: openRound.id,
      cancelledRoundNumber: openRound.roundNumber,
    });
  } catch (error: any) {
    console.error("CANCEL CORRECTION ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 },
    );
  }
}
