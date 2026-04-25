import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { classifyGstinConflict } from "@/lib/dealer/duplicate-check";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  try {
    const { dealerId } = await context.params;

    const rows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = rows[0];
    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }

    const classification = await classifyGstinConflict(application);

    return NextResponse.json({
      success: true,
      dealerId: application.id,
      isBranchDealer: application.isBranchDealer,
      ...classification,
    });
  } catch (error: any) {
    console.error("DUPLICATE CHECK ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to classify duplicate" },
      { status: 500 }
    );
  }
}
