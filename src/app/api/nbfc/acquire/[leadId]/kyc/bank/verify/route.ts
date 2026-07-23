/**
 * POST /api/nbfc/acquire/[leadId]/kyc/bank/verify
 *
 * NBFC-side mirror of the admin Bank verify. Reuses `executeBankVerification`
 * (refreshes the shared kyc_verifications row) without stamping the dealer's KYC
 * coupon. Returns the admin `{ success, data, error }` shape the cards read.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeBankVerification } from "@/lib/kyc/bank-verification";

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

    const result = await executeBankVerification(leadId, {
      accountNumber: body.account_number,
      ifsc: body.ifsc,
      name: body.name,
      performNameMatch: body.perform_name_match,
      validationType: body.validation_type,
    });

    if ("error" in result) {
      // error may be a string OR { message, code } (env-misconfig branch, which
      // the BankCard reads via error.code === 'bank_verify_misconfigured').
      const errorPayload =
        typeof result.error === "string" ? { message: result.error } : result.error;
      return NextResponse.json(
        { success: false, error: errorPayload },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[NBFC Bank Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify bank account";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
