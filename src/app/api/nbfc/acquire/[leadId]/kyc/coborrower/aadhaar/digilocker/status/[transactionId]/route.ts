/**
 * GET /api/nbfc/acquire/[leadId]/kyc/coborrower/aadhaar/digilocker/status/[transactionId]
 *
 * NBFC mirror of the admin co-borrower-Aadhaar DigiLocker status route
 * (src/app/api/admin/kyc/[leadId]/coborrower/aadhaar/digilocker/status/[transactionId]/route.ts).
 * Reuses the shared executeCoBorrowerDigilockerStatus service. Read-only poll —
 * any assigned seat under the tenant may read it, so this mirrors the run
 * route's actor resolution but omits the mutate-only role gate.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCoBorrowerDigilockerStatus } from "@/lib/kyc/coborrower-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; transactionId: string }> },
) {
  try {
    const { leadId, transactionId } = await params;

    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "no assignment for this lead under this tenant" },
        },
        { status: 400 },
      );
    }

    const result = await executeCoBorrowerDigilockerStatus(
      leadId,
      transactionId,
    );

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[NBFC Co-Borrower DigiLocker Status] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check co-borrower DigiLocker status";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
