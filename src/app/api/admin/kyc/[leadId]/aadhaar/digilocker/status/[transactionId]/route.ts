import { NextRequest, NextResponse } from "next/server";

import { executeDigilockerStatus } from "@/lib/kyc/digilocker";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; transactionId: string }> },
) {
  try {
    const appUser = await requireAdminAppUserForLead((await params).leadId);
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, transactionId } = await params;
    const result = await executeDigilockerStatus(leadId, transactionId);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[DigiLocker Status] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check DigiLocker status";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
