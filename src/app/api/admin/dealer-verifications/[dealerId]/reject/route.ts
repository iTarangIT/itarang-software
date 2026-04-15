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
        onboardingStatus: "rejected",
        reviewStatus: "rejected",
        rejectedAt: new Date(),
        rejectionRemarks: body.remarks || null,
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("REJECT DEALER ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Reject failed" },
      { status: 500 }
    );
  }
}