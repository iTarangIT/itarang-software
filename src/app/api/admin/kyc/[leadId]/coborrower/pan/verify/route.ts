import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerPanVerification } from "@/lib/kyc/coborrower-verification";

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

    const result = await executeCoBorrowerPanVerification(leadId, {
      panNumber: body.pan_number,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower PAN Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify co-borrower PAN";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
