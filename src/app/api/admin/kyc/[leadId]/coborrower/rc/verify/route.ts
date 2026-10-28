import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";
import { executeRcVerification } from "@/lib/kyc/rc-verification";

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

    const result = await executeRcVerification(leadId, {
      rcNumber: typeof body?.rc_number === "string" ? body.rc_number : undefined,
      applicant: "co_borrower",
    });
    // ID 201: the check, who ran it and its outcome in the file's KYC history.
    await recordStaffKycStep(leadId, appUser, "RC check run (co-borrower)", { result });

    // Validation short-circuit (Decentro was NOT called): surface the status.
    if (result.status) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Co-borrower RC never stamped the dealer coupon — keep it that way.
    return NextResponse.json({
      success: result.success,
      data: result.data,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    console.error("[Co-Borrower RC Verify] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to verify co-borrower RC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
