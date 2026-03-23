import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;
    const body = await req.json();

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "under_correction",
        reviewStatus: "correction_requested",
        correctionRemarks: body.remarks || null,
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("REQUEST CORRECTION ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Correction request failed" },
      { status: 500 }
    );
  }
}