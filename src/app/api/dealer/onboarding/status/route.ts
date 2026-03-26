import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { desc, eq } from "drizzle-orm";

function resolveDealerStatus(application: {
  onboardingStatus?: string | null;
  reviewStatus?: string | null;
  agreementStatus?: string | null;
  dealerAccountStatus?: string | null;
}) {
  const onboardingStatus = (application.onboardingStatus || "draft").toLowerCase();
  const reviewStatus = (application.reviewStatus || "").toLowerCase();
  const agreementStatus = (application.agreementStatus || "").toLowerCase();
  const dealerAccountStatus = (application.dealerAccountStatus || "").toLowerCase();

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

    const application = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.dealerUserId, user.id))
      .orderBy(desc(dealerOnboardingApplications.updatedAt))
      .limit(1);

    if (!application.length) {
      return NextResponse.json({
        status: "draft",
        onboardingStatus: "draft",
        reviewStatus: null,
        agreementStatus: "not_generated",
        dealerAccountStatus: "inactive",
      });
    }

    const current = application[0];
    const status = resolveDealerStatus(current);

    return NextResponse.json({
      status,
      onboardingStatus: current.onboardingStatus || "draft",
      reviewStatus: current.reviewStatus || null,
      agreementStatus: current.agreementStatus || "not_generated",
      dealerAccountStatus: current.dealerAccountStatus || "inactive",
      submittedAt: current.submittedAt || null,
      approvedAt: current.approvedAt || null,
      rejectedAt: current.rejectedAt || null,
      correctionRemarks: current.correctionRemarks || null,
      rejectionRemarks: current.rejectionRemarks || null,
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