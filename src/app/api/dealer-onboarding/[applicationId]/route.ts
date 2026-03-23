import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ applicationId: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { applicationId } = await context.params;

    const application = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, applicationId));

    return NextResponse.json({
      success: true,
      application: application[0] ?? null,
    });
  } catch (error: any) {
    console.error("GET ONBOARDING BY ID ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch onboarding application",
      },
      { status: 500 }
    );
  }
}