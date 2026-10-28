import { NextRequest, NextResponse } from "next/server";

import { executeCibilReport } from "@/lib/kyc/cibil-verification";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { recordStaffKycStep } from "@/lib/kyc/kycEventLog";

// Mirrors the primary CIBIL report route at
// src/app/api/admin/kyc/[leadId]/cibil/report/route.ts but sources data from
// the coBorrowers row and persists with applicant='co_borrower'. Same Decentro
// endpoint, same response-shape contract that CIBILCard.tsx already speaks. The
// shared shaping lives in @/lib/kyc/cibil-verification.
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

    const result = await executeCibilReport(leadId, { applicant: "co_borrower" });
    // ID 201: the check, who ran it and its outcome in the file's KYC history.
    await recordStaffKycStep(leadId, appUser, "CIBIL report pulled (co-borrower)", { result });

    return NextResponse.json(
      {
        success: result.success,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      result.status ? { status: result.status } : undefined,
    );
  } catch (error) {
    console.error("[Co-Borrower CIBIL Report] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL report";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
