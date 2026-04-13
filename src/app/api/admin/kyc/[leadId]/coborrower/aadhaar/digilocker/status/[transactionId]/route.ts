import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerDigilockerStatus } from "@/lib/kyc/coborrower-verification";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; transactionId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, transactionId } = await params;
    const result = await executeCoBorrowerDigilockerStatus(
      leadId,
      transactionId,
    );

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower DigiLocker Status] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check co-borrower DigiLocker status";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
