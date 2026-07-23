import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerificationMetadata } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeRcVerification } from "@/lib/kyc/rc-verification";

export async function POST(
  req: NextRequest,
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
    const body = await req.json();

    const result = await executeRcVerification(leadId, {
      rcNumber: typeof body?.rc_number === "string" ? body.rc_number : undefined,
      applicant: "primary",
    });

    // Validation short-circuit (Decentro was NOT called): surface the status and
    // do NOT stamp the coupon — identical to the old inline early-returns.
    if (result.status) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Decentro ran (success or failure): record the dealer's first API execution
    // if not already set — the coupon stamp lives in the admin route only.
    const now = new Date();
    const metadataRows = await db
      .select({
        first_api_execution_at: kycVerificationMetadata.first_api_execution_at,
      })
      .from(kycVerificationMetadata)
      .where(eq(kycVerificationMetadata.lead_id, leadId))
      .limit(1);

    if (metadataRows[0] && !metadataRows[0].first_api_execution_at) {
      await db
        .update(kycVerificationMetadata)
        .set({
          first_api_execution_at: now,
          first_api_type: "rc",
          verification_started_at: now,
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));
    }

    return NextResponse.json({
      success: result.success,
      data: result.data,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    console.error("[RC Verification] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify RC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
