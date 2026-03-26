import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        {
          success: false,
          message: "Application not found",
        },
        { status: 404 }
      );
    }

    if (!application.financeEnabled) {
      return NextResponse.json(
        {
          success: false,
          message: "Agreement refresh is only available for finance-enabled applications.",
        },
        { status: 400 }
      );
    }

    if (!application.providerDocumentId) {
      return NextResponse.json(
        {
          success: false,
          message: "Agreement has not been initiated yet. Please initiate agreement first.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Current agreement status fetched successfully",
      data: {
        agreementStatus: application.agreementStatus || "not_generated",
        reviewStatus: application.reviewStatus || "pending_sales_head",
        requestId: application.requestId || null,
        providerDocumentId: application.providerDocumentId || null,
        providerSigningUrl: application.providerSigningUrl || null,
        stampStatus: application.stampStatus || "pending",
        completionStatus: application.completionStatus || "pending",
        signedAt: application.signedAt || null,
        lastActionTimestamp: application.lastActionTimestamp || null,
      },
    });
  } catch (error: any) {
    console.error("REFRESH AGREEMENT ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to refresh agreement status",
      },
      { status: 500 }
    );
  }
}