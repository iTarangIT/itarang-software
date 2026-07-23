import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerificationMetadata } from "@/lib/db/schema";
import { executeCibilReport } from "@/lib/kyc/cibil-verification";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;

    const result = await executeCibilReport(leadId, { applicant: "primary" });

    // Coupon / first-API-execution stamp — admin-only, and only once the
    // provider actually ran (helper sets `status` on early-return failures).
    if (result.status === undefined) {
      const now = new Date();
      const metadataRows = await db
        .select({
          first_api_execution_at:
            kycVerificationMetadata.first_api_execution_at,
        })
        .from(kycVerificationMetadata)
        .where(eq(kycVerificationMetadata.lead_id, leadId))
        .limit(1);

      if (metadataRows[0] && !metadataRows[0].first_api_execution_at) {
        await db
          .update(kycVerificationMetadata)
          .set({
            first_api_execution_at: now,
            first_api_type: "cibil",
            verification_started_at: now,
            updated_at: now,
          })
          .where(eq(kycVerificationMetadata.lead_id, leadId));
      }
    }

    return NextResponse.json(
      {
        success: result.success,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      result.status ? { status: result.status } : undefined,
    );
  } catch (error) {
    console.error("[CIBIL Report] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL report";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
