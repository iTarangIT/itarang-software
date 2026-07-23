/**
 * POST /api/nbfc/acquire/[leadId]/kyc/coborrower/aadhaar/digilocker/resend-sms
 *
 * NBFC mirror of the admin co-borrower-Aadhaar DigiLocker resend-sms route
 * (src/app/api/admin/kyc/[leadId]/coborrower/aadhaar/digilocker/resend-sms/route.ts).
 * Reuses the shared executeCoBorrowerDigilockerResendSms service. NBFC auth
 * (resolveActor + role gate + active assignment); no coupon side-effect.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCoBorrowerDigilockerResendSms } from "@/lib/kyc/coborrower-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        {
          success: false,
          error: { message: `role '${actor.role}' cannot run verifications` },
        },
        { status: 403 },
      );
    }
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

    const result = await executeCoBorrowerDigilockerResendSms(leadId);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[NBFC Co-Borrower DigiLocker Resend-SMS] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to resend SMS";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
