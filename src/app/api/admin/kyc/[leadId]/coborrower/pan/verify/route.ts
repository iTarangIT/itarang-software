import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";
import { executeCoBorrowerPanVerification } from "@/lib/kyc/coborrower-verification";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUserForLead((await params).leadId);
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;
    const body = await req.json();

    const result = await executeCoBorrowerPanVerification(leadId, {
      panNumber: body.pan_number,
    });
    // ID 201: the check, who ran it and its outcome in the file's KYC history.
    await recordStaffKycStep(leadId, appUser, "PAN check run (co-borrower)", { result });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower PAN Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify co-borrower PAN";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
