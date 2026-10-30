import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";
import { executeCoBorrowerDigilockerStatus } from "@/lib/kyc/coborrower-verification";

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

    // ID 201: polled, so only the end of a DigiLocker request is logged, once
    // per request and outcome. The verification row is reused when the
    // request is run again, so "expired" is keyed by the session's start.
    const state = result.data?.status;
    if (state === "document_fetched") {
      await recordStaffKycStep(leadId, appUser, "Aadhaar fetched from DigiLocker (co-borrower)", {
        once: `digilocker:${transactionId}:document_fetched`,
      });
    } else if (state === "expired") {
      const started = "initiatedAt" in result.data ? (result.data.initiatedAt ?? "") : "";
      await recordStaffKycStep(leadId, appUser, "DigiLocker (Aadhaar) request expired (co-borrower)", {
        once: `digilocker:${transactionId}:expired:${started}`,
      });
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
