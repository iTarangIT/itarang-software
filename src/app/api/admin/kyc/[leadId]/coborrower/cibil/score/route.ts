import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerCibilScore } from "@/lib/kyc/coborrower-verification";

// Co-borrower CIBIL is stored via manual entry in v1 (the primary CIBIL flow
// is tightly coupled to primary-applicant tables and cannot be reused 1-to-1
// without a refactor). Admin enters the score / report id and the helper
// writes a kyc_verifications row with applicant='co_borrower'.

export async function POST(
  req: NextRequest,
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
    const body = await req.json();

    const score =
      typeof body.score === "number"
        ? body.score
        : typeof body.score === "string"
          ? Number(body.score)
          : undefined;

    const result = await executeCoBorrowerCibilScore(leadId, {
      score: Number.isFinite(score) ? score : undefined,
      reportId: body.report_id,
      note: body.note,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower CIBIL Score] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to record co-borrower CIBIL score";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
