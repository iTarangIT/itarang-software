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
          message: "Rejection remarks are required",
        },
        { status: 400 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "rejected",
        reviewStatus: "rejected",
        dealerAccountStatus: "inactive",
        completionStatus: "pending",
        rejectedAt: new Date(),
        rejectionReason: remarks,
        rejectionRemarks: remarks,
        correctionRemarks: null,
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    console.log("DEALER REJECTED:", {
      dealerId,
      remarks,
      rejectedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      message: "Dealer application rejected successfully",
    });
  } catch (error: any) {
    console.error("REJECT DEALER ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Reject failed",
      },
      { status: 500 }
    );
  }
}