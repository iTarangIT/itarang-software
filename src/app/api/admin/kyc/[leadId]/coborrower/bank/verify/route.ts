import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerBankVerification } from "@/lib/kyc/coborrower-verification";

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

    const result = await executeCoBorrowerBankVerification(leadId, {
      account_number: body.account_number,
      ifsc: body.ifsc,
      name: body.name,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower Bank Verify] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to verify co-borrower bank";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
