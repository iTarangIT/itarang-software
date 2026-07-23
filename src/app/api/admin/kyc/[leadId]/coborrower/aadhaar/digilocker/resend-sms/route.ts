import { NextRequest, NextResponse } from "next/server";

import { executeCoBorrowerDigilockerResendSms } from "@/lib/kyc/coborrower-verification";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

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
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;
    const result = await executeCoBorrowerDigilockerResendSms(leadId);
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
