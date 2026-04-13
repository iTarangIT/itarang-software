import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerCibilScore } from "@/lib/kyc/coborrower-verification";

// In v1, the co-borrower "full report" action routes back through the same
// helper as score — the admin enters score + report id manually. When the
// co-borrower CIBIL API refactor lands, this route will be swapped out for a
// real Decentro credit report call.

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
    console.error("[Co-Borrower CIBIL Report] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to record co-borrower CIBIL report";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
