import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerificationMetadata } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeBankVerification } from "@/lib/kyc/bank-verification";

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

    const result = await executeBankVerification(leadId, {
      accountNumber: body.account_number,
      ifsc: body.ifsc,
      name: body.name,
      performNameMatch: body.perform_name_match,
      validationType: body.validation_type,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    // Record first API execution in metadata (BRD §1: coupon consumed on first paid API call)
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
          first_api_type: "bank",
          verification_started_at: now,
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Admin Bank Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify bank account";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
