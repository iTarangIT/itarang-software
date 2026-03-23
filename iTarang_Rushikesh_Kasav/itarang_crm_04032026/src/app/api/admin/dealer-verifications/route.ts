import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const applications = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.companyName,
        companyType: dealerOnboardingApplications.companyType,
        gstNumber: dealerOnboardingApplications.gstNumber,
        financeEnabled: dealerOnboardingApplications.financeEnabled,
        onboardingStatus: dealerOnboardingApplications.onboardingStatus,
        reviewStatus: dealerOnboardingApplications.reviewStatus,
        submittedAt: dealerOnboardingApplications.submittedAt,
        createdAt: dealerOnboardingApplications.createdAt,
      })
      .from(dealerOnboardingApplications)
      .orderBy(desc(dealerOnboardingApplications.createdAt));

    const formatted = applications.map((item) => ({
      dealerId: item.id,
      dealerName: item.companyName,
      companyName: item.companyName,
      documents: "Pending", // replace with real count after document table integration
      agreement: item.financeEnabled ? "Required" : "N/A",
      status: item.onboardingStatus,
      submittedAt: item.submittedAt,
      gstNumber: item.gstNumber,
      financeEnabled: item.financeEnabled,
      companyType: item.companyType,
    }));

    return NextResponse.json({
      success: true,
      applications: formatted,
    });
  } catch (error: any) {
    console.error("ADMIN to DEALER VERIFICATIONS LIST ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch dealer verifications",
      },
      { status: 500 }
    );
  }
}