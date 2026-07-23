import { NextRequest, NextResponse } from "next/server";

import { executeCibilScore } from "@/lib/kyc/cibil-verification";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// Mirrors the primary CIBIL score route at
// src/app/api/admin/kyc/[leadId]/cibil/score/route.ts but sources name / pan /
// dob / phone / address from the coBorrowers row and persists with
// applicant='co_borrower'. The shared shaping lives in
// @/lib/kyc/cibil-verification.
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

    const result = await executeCibilScore(leadId, { applicant: "co_borrower" });

    return NextResponse.json(
      {
        success: result.success,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      result.status ? { status: result.status } : undefined,
    );
  } catch (error) {
    console.error("[Co-Borrower CIBIL Score] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL score";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
