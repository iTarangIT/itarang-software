/**
 * POST /api/nbfc/acquire/[leadId]/kyc/coborrower/pan/verify
 *
 * NBFC-side mirror of the admin co-borrower PAN verify. Reuses
 * `executeCoBorrowerPanVerification` without stamping the KYC coupon.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCoBorrowerPanVerification } from "@/lib/kyc/coborrower-verification";

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
    console.error("[NBFC Co-Borrower PAN Verify] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify co-borrower PAN";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
