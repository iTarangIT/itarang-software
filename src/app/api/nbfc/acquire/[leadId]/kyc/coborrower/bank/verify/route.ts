/**
 * POST /api/nbfc/acquire/[leadId]/kyc/coborrower/bank/verify
 *
 * NBFC-side mirror of the admin co-borrower Bank verify. Reuses
 * `executeCoBorrowerBankVerification` without stamping the KYC coupon.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCoBorrowerBankVerification } from "@/lib/kyc/coborrower-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { success: false, error: { message: `Role '${actor.role}' cannot run verifications` } },
        { status: 403 },
      );
    }
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { success: false, error: { message: "No assignment for this lead under this tenant" } },
        { status: 400 },
      );
    }

    const body = await req.json();

    const result = await executeCoBorrowerBankVerification(leadId, {
      account_number: body.account_number,
      ifsc: body.ifsc,
      name: body.name,
      perform_name_match: body.perform_name_match,
      validation_type: body.validation_type,
    });

    if ("error" in result) {
      const errorPayload =
        typeof result.error === "string" ? { message: result.error } : result.error;
      return NextResponse.json(
        { success: false, error: errorPayload },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[NBFC Co-Borrower Bank Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify co-borrower bank";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
