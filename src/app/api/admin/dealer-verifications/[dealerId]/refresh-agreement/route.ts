export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { refreshDealerAgreementFromDigio } from "@/lib/agreement/refresh-dealer-agreement";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

// Manual "Refresh Status" click. The actual Digio sync + PDF caching lives in
// refreshDealerAgreementFromDigio so the agreement-tracking GET can run the
// same thing in the background; this route just adapts it to an HTTP response.
export async function POST(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
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
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    const result = await refreshDealerAgreementFromDigio(application, { source: "manual" });

    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message, ...(result.raw !== undefined ? { raw: result.raw } : {}) },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      agreementStatus: result.agreementStatus,
      signedAgreementUrl: result.signedAgreementUrl,
      auditTrailUrl: result.auditTrailUrl,
      stampCertificateIds: result.stampCertificateIds,
    });
  } catch (error: any) {
    console.error("REFRESH AGREEMENT ERROR:", error);

    return NextResponse.json(
      { success: false, message: error?.message || "Failed to refresh agreement status" },
      { status: 500 }
    );
  }
}
