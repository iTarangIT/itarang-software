import { NextRequest, NextResponse } from "next/server";

import { executeDigilockerStatus } from "@/lib/kyc/digilocker";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";

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
    // ID 201: this is polled, so only the end of a DigiLocker request is
    // logged, once per request and outcome.
    const state = (result.body as { data?: { status?: string } } | null)?.data?.status;
    if (state === "document_fetched" || state === "expired" || state === "failed") {
      await recordStaffKycStep(
        leadId,
        appUser,
        state === "document_fetched" ? "Aadhaar fetched from DigiLocker" : `DigiLocker (Aadhaar) request ${state}`,
        { once: `digilocker:${transactionId}:${state}` },
      );
    }
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
