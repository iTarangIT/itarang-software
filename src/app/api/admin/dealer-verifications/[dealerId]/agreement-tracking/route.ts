import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { canReInitiateAgreement } from "@/lib/agreement/status";

type Context = {
  params: Promise<{ dealerId: string }>;
};

export async function GET(_req: NextRequest, context: Context) {
  try {
    const { dealerId } = await context.params;

    console.log("[AGREEMENT TRACKING] dealerId:", dealerId);

    let applicationRows: any[] = [];

    try {
      applicationRows = await db
        .select()
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, dealerId))
        .limit(1);

      console.log("[AGREEMENT TRACKING] application query success");
    } catch (error: any) {
      console.error("[AGREEMENT TRACKING] application query failed:", error);
      return NextResponse.json(
        {
          success: false,
          message:
            error?.message || "Failed while loading dealer onboarding application",
        },
        { status: 500 }
      );
    }

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    let signerRows: any[] = [];

    try {
      signerRows = await db
        .select()
        .from(dealerAgreementSigners)
        .where(eq(dealerAgreementSigners.applicationId, dealerId));

      console.log(
        "[AGREEMENT TRACKING] signer rows query success. Count:",
        signerRows.length
      );
    } catch (error: any) {
      console.error("[AGREEMENT TRACKING] signer rows query failed:", error);
      return NextResponse.json(
        {
          success: false,
          message:
            error?.message || "Failed while loading agreement signer rows",
        },
        { status: 500 }
      );
    }

    const signerOrder = [
      "dealer",
      "financier",
      "itarang_signatory_1",
      "itarang_signatory_2",
    ];

    const signers = [...signerRows].sort((a, b) => {
      const aIndex = signerOrder.indexOf(a.signerRole);
      const bIndex = signerOrder.indexOf(b.signerRole);

      const safeAIndex = aIndex === -1 ? 999 : aIndex;
      const safeBIndex = bIndex === -1 ? 999 : bIndex;

      return safeAIndex - safeBIndex;
    });

    let events: any[] = [];

    try {
      events = await db
        .select()
        .from(dealerAgreementEvents)
        .where(eq(dealerAgreementEvents.applicationId, dealerId))
        .orderBy(desc(dealerAgreementEvents.createdAt));

      console.log(
        "[AGREEMENT TRACKING] event rows query success. Count:",
        events.length
      );
    } catch (error: any) {
      console.error("[AGREEMENT TRACKING] event rows query failed:", error);
      return NextResponse.json(
        {
          success: false,
          message:
            error?.message || "Failed while loading agreement timeline events",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        applicationId: application.id,
        agreementId: application.providerDocumentId || null,
        requestId: application.requestId || null,
        agreementStatus: application.agreementStatus || "not_generated",
        reviewStatus: application.reviewStatus || null,
        signedAgreementUrl: application.signedAgreementUrl || null,
        auditTrailUrl: application.auditTrailUrl || null,
        completionStatus: application.completionStatus || null,
        stampStatus: application.stampStatus || null,
        failureReason: application.agreementFailureReason || null,
        lastActionTimestamp: application.lastActionTimestamp || null,
        canReInitiate: canReInitiateAgreement(application.agreementStatus),
        signers,
        timeline: events,
      },
    });
  } catch (error: any) {
    console.error("AGREEMENT TRACKING GET ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch agreement tracking",
      },
      { status: 500 }
    );
  }
}