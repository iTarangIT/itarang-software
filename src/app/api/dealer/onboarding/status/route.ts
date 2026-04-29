import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeRole } from "@/lib/roles";
import { findLatestDealerOnboardingApplication } from "@/lib/dealer-onboarding";
import { findSupabaseUserProfile } from "@/lib/supabase/identity";

function resolveDealerStatus(application: {
  onboarding_status?: string | null;
  review_status?: string | null;
  agreement_status?: string | null;
  dealer_account_status?: string | null;
}) {
  const onboardingStatus = (application.onboarding_status || "draft").toLowerCase();
  const reviewStatus = (application.review_status || "").toLowerCase();
  const agreementStatus = (application.agreement_status || "").toLowerCase();
  const dealerAccountStatus = (application.dealer_account_status || "").toLowerCase();

  if (
    onboardingStatus === "approved" &&
    dealerAccountStatus === "active"
  ) {
    return "approved";
  }

  if (onboardingStatus === "rejected") {
    return "rejected";
  }

  if (onboardingStatus === "correction_requested") {
    return "correction_requested";
  }

  if (onboardingStatus === "draft") {
    return "draft";
  }

  if (reviewStatus === "pending_sales_head") {
    return "pending_sales_head";
  }

  if (reviewStatus === "under_review") {
    return "under_review";
  }

  if (reviewStatus === "agreement_in_progress") {
    return "agreement_in_progress";
  }

  if (reviewStatus === "agreement_completed") {
    return "agreement_completed";
  }

  if (onboardingStatus === "submitted") {
    return "submitted";
  }

  if (agreementStatus === "sent_for_signature") {
    return "agreement_in_progress";
  }

  if (agreementStatus === "partially_signed") {
    return "agreement_in_progress";
  }

  if (agreementStatus === "completed") {
    return "agreement_completed";
  }

  return "draft";
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({
        status: "draft",
        onboardingStatus: "draft",
        reviewStatus: null,
        agreementStatus: "not_generated",
        dealerAccountStatus: "inactive",
      });
    }

    const profile = await findSupabaseUserProfile<{
      id?: string | null;
      email?: string | null;
      role?: string | null;
    }>(supabase, user, "id,email,role");

    if (profile?.role && normalizeRole(profile.role) !== "dealer") {
      return NextResponse.json(
        { success: false, message: "Access denied" },
        { status: 403 }
      );
    }

    const currentApplication = await findLatestDealerOnboardingApplication({
      authUserId: user.id,
      profileUserId: profile?.id || null,
      email: profile?.email || user.email || null,
    });

    if (!currentApplication) {
      return NextResponse.json({
        status: "draft",
        onboardingStatus: "draft",
        reviewStatus: null,
        agreementStatus: "not_generated",
        dealerAccountStatus: "inactive",
      });
    }

    const status = resolveDealerStatus(currentApplication);

    return NextResponse.json({
      status,
      onboardingStatus: currentApplication.onboarding_status || "draft",
      reviewStatus: currentApplication.review_status || null,
      agreementStatus: currentApplication.agreement_status || "not_generated",
      dealerAccountStatus: currentApplication.dealer_account_status || "inactive",
      submittedAt: currentApplication.submitted_at || null,
      approvedAt: currentApplication.approved_at || null,
      rejectedAt: currentApplication.rejected_at || null,
      correctionRemarks: currentApplication.correction_remarks || null,
      rejectionRemarks: currentApplication.rejection_remarks || null,
    });
  } catch (error) {
    console.error("Onboarding status fetch error:", error);

    return NextResponse.json({
      status: "draft",
      onboardingStatus: "draft",
      reviewStatus: null,
      agreementStatus: "not_generated",
      dealerAccountStatus: "inactive",
    });
  }
}
