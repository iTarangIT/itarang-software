import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { requestCoBorrowerForLead } from "@/lib/kyc/coborrower-request";

// BRD §2.9.3 "Request Co-Borrower KYC" — admin opens this form from the CIBIL
// card or the primary final-decision panel. The route creates a stub
// coBorrowers row (if none exists) and a co_borrower_requests row tracking the
// attempt number. Lead kyc_status flips into a Step 3 co-borrower waiting
// state so the dealer's interim KYC page becomes accessible.

const bodySchema = z.object({
  reason: z.string().min(1, "Reason is required"),
  is_replacement: z.boolean().optional(),
});

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
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Validation failed",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      );
    }

    const { reason, is_replacement } = parsed.data;

    const result = await requestCoBorrowerForLead(leadId, {
      reason,
      adminUserId: appUser.id,
      isReplacement: is_replacement,
    });
    if (!result) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        request_id: result.request_id,
        attempt_number: result.attempt_number,
        lead_status: result.lead_status,
      },
    });
  } catch (error) {
    console.error("[Admin Step3 Request Co-Borrower] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to request co-borrower KYC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
