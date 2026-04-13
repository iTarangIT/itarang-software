import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerDigilockerInit } from "@/lib/kyc/coborrower-verification";

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
    const body = await req.json().catch(() => ({}));

    const result = await executeCoBorrowerDigilockerInit(leadId, {
      phone: body.phone,
      email: body.email,
      redirect_url: body.redirect_url,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower DigiLocker Init] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to initiate co-borrower DigiLocker session";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
