import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { insertAgreementEvent } from "@/lib/agreement/tracking";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

/**
 * Post-approval finance enablement — step 1 of 2.
 *
 * A dealer who answered "no" to financing during onboarding (common on the
 * WhatsApp flow, where it's a single yes/no tap) is approved with
 * finance_enabled=false and NO dealer agreement. There was previously no way
 * back: `initiate-agreement` 400s on non-finance applications, `approve`
 * refuses to run twice, and the admin PATCH doesn't accept financeEnabled — so
 * the only route was an un-approve/re-approve cycle, which regenerates the
 * dealer's password and re-sends their credentials.
 *
 * This flips the application's finance flag ONLY, so the existing "Initiate
 * Agreement" button becomes available and the normal Digio signing flow runs
 * unchanged. Finance does NOT go live here: `dealers.finance_enabled` — the
 * flag the E-105 lead-creation gate and the WhatsApp console read — stays false
 * until the agreement is signed and `activate-finance` is called.
 *
 * Deliberately does not touch onboarding_status / dealer_account_status: the
 * dealer stays approved and active throughout, keeping their login, their
 * WhatsApp console, and their cash-lead capability working while the agreement
 * is in flight.
 */
export async function POST(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [application] = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.company_name,
        dealerCode: dealerOnboardingApplications.dealer_code,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
        agreementStatus: dealerOnboardingApplications.agreement_status,
        ownerAadhaar: dealerOnboardingApplications.owner_aadhaar_no,
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

    // This route exists only for the post-approval case. An application that
    // hasn't been approved yet should change its answer through the normal
    // correction flow, which re-runs the full review.
    if (application.onboardingStatus !== "approved") {
      return NextResponse.json(
        {
          success: false,
          message:
            "Finance can only be enabled this way for an already-approved dealer. " +
            "For an application still under review, request a correction instead.",
        },
        { status: 400 },
      );
    }

    if (application.financeEnabled) {
      return NextResponse.json(
        {
          success: false,
          message: "Finance is already enabled on this application.",
        },
        { status: 400 },
      );
    }

    // E-175 pre-flight. initiate-agreement hard-blocks Aadhaar e-sign unless the
    // owner's 12-digit Aadhaar is on file, because the signer-match check has
    // nothing to compare against otherwise. Surface that here rather than
    // letting the admin enable finance and then hit a wall on the next click.
    const ownerAadhaar = String(application.ownerAadhaar || "").replace(/\D/g, "");
    const aadhaarOnFile = ownerAadhaar.length === 12;

    await db
      .update(dealerOnboardingApplications)
      .set({
        finance_enabled: true,
        // The agreement has never been generated for this dealer. Normalise the
        // status so initiate-agreement's canInitiateStatuses check passes.
        agreement_status: "not_generated",
        last_action_timestamp: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await insertAgreementEvent({
      applicationId: dealerId,
      eventType: "finance_enabled_post_approval",
      eventStatus: "pending_agreement",
      eventPayload: {
        enabledBy: auth.user.email ?? auth.user.id,
        previousAgreementStatus: application.agreementStatus ?? null,
        ownerAadhaarOnFile: aadhaarOnFile,
      },
    });

    console.log("POST-APPROVAL FINANCE ENABLED:", {
      applicationId: dealerId,
      dealerCode: application.dealerCode,
      company: application.companyName,
      aadhaarOnFile,
    });

    return NextResponse.json({
      success: true,
      message: aadhaarOnFile
        ? "Finance enabled. Initiate the dealer agreement next — finance goes live once it's signed."
        : "Finance enabled, but the owner's 12-digit Aadhaar is not on file. " +
          "Aadhaar e-sign will be blocked until it's captured (re-upload the Owner " +
          "Aadhaar document) or the dealer's signing method is changed.",
      ownerAadhaarOnFile: aadhaarOnFile,
      // dealers.finance_enabled is intentionally still false — finance is not
      // live until the agreement completes and activate-finance runs.
      financeLive: false,
    });
  } catch (error: any) {
    console.error("ENABLE FINANCE ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to enable finance" },
      { status: 500 },
    );
  }
}
