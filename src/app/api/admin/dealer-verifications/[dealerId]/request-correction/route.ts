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

    const remarks =
      typeof body?.remarks === "string" ? body.remarks.trim() : "";

    if (!remarks) {
      return NextResponse.json(
        {
          success: false,
          message: "Correction remarks are required",
        },
        { status: 400 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "correction_requested",
        reviewStatus: "correction_requested",
        dealerAccountStatus: "inactive",
        completionStatus: "pending",
        correctionRemarks: remarks,
        rejectedAt: null,
        rejectionReason: null,
        rejectionRemarks: null,
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    console.log("DEALER CORRECTION REQUESTED:", {
      dealerId,
      remarks,
      requestedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      message: "Correction request submitted successfully",
    });
  } catch (error: any) {
    console.error("REQUEST CORRECTION ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Correction request failed",
      },
      { status: 500 }
    );
  }
}