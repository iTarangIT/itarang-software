import { NextRequest, NextResponse } from "next/server";

import { executeCoBorrowerDigilockerResendSms } from "@/lib/kyc/coborrower-verification";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";

/**
 * Co-borrower variant of the DigiLocker resend-sms endpoint.
 *
 * The session lives in `kyc_verifications.api_response.data` keyed by
 * (lead_id, verification_type='aadhaar', applicant='co_borrower'); the shared
 * service picks the latest such row and pushes a fresh SMS to the co-borrower's
 * phone without burning a second Decentro credit.
 */
export async function POST(
  _req: NextRequest,
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
    const result = await executeCoBorrowerDigilockerResendSms(leadId);
    // ID 201: the check, who ran it and its outcome in the file's KYC history.
    await recordStaffKycStep(leadId, appUser, "DigiLocker (Aadhaar) SMS resent (co-borrower)", { result });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[Co-Borrower DigiLocker Resend-SMS] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to resend SMS";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
