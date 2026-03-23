import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const applications = await db
      .select()
      .from(dealerOnboardingApplications)
      .orderBy(desc(dealerOnboardingApplications.createdAt));

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