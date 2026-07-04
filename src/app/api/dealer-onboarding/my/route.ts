import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

// Lists the onboarding applications CREATED BY the current user (drafts +
// submitted), for the "My Drafts" chooser. Scoped to dealer_user_id so internal
// staff onboarding several dealers each see only their own in-progress rows —
// unlike /dealer-onboarding/list which returns every application unfiltered.
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Middleware treats /api/* as public, so enforce auth here.
    if (!user) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const rows = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.company_name,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
        reviewStatus: dealerOnboardingApplications.review_status,
        draftStep: dealerOnboardingApplications.draft_step,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        dealerCode: dealerOnboardingApplications.dealer_code,
        createdAt: dealerOnboardingApplications.created_at,
        updatedAt: dealerOnboardingApplications.updated_at,
        submittedAt: dealerOnboardingApplications.submitted_at,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.dealer_user_id, user.id))
      .orderBy(desc(dealerOnboardingApplications.updated_at));

    return NextResponse.json({ success: true, applications: rows });
  } catch (error: any) {
    console.error("MY ONBOARDING LIST ERROR:", error);
    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch your onboarding applications",
      },
      { status: 500 }
    );
  }
}
