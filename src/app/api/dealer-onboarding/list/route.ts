import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// Middleware treats /api/* as public (src/middleware.ts), so this route must
// gate itself. Until it did, an anonymous GET returned every onboarding
// application in full — the security scanner flags it as a CRITICAL PII
// exposure (src/lib/security/crawl.ts).
//
// Two things are enforced here:
//   1. requireAdmin() — session + one of admin/ceo/business_head/sales_head.
//   2. An explicit column list. The old bare `db.select()` also shipped
//      `provider_raw_response` (the full submission snapshot: owner Aadhaar,
//      bank account, PAN, signed-document URLs) plus bank/account columns.
//      Nothing needs those in a list view; the admin UI reads a single
//      application through /api/admin/dealer-verifications/[dealerId].
//
// The dealer-facing owner-scoped list is /api/dealer-onboarding/my.
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const applications = await db
      .select({
        id: dealerOnboardingApplications.id,
        dealer_user_id: dealerOnboardingApplications.dealer_user_id,
        company_name: dealerOnboardingApplications.company_name,
        company_type: dealerOnboardingApplications.company_type,
        dealer_type: dealerOnboardingApplications.dealer_type,
        dealer_code: dealerOnboardingApplications.dealer_code,
        onboarding_status: dealerOnboardingApplications.onboarding_status,
        review_status: dealerOnboardingApplications.review_status,
        dealer_account_status:
          dealerOnboardingApplications.dealer_account_status,
        draft_step: dealerOnboardingApplications.draft_step,
        finance_enabled: dealerOnboardingApplications.finance_enabled,
        owner_name: dealerOnboardingApplications.owner_name,
        city: dealerOnboardingApplications.city,
        state: dealerOnboardingApplications.state,
        agreement_status: dealerOnboardingApplications.agreement_status,
        created_at: dealerOnboardingApplications.created_at,
        updated_at: dealerOnboardingApplications.updated_at,
        submitted_at: dealerOnboardingApplications.submitted_at,
        approved_at: dealerOnboardingApplications.approved_at,
        rejected_at: dealerOnboardingApplications.rejected_at,
      })
      .from(dealerOnboardingApplications)
      .orderBy(desc(dealerOnboardingApplications.created_at));

    return NextResponse.json({
      success: true,
      applications,
    });
  } catch (error: any) {
    console.error("LIST ONBOARDING ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch onboarding applications",
      },
      { status: 500 }
    );
  }
}
