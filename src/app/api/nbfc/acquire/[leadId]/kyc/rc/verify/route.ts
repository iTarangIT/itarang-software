/**
 * POST /api/nbfc/acquire/[leadId]/kyc/rc/verify
 *
 * NBFC-side mirror of the admin primary RC-verify route. The NBFC re-runs the
 * SAME Decentro RC→chassis check from its Acquire dashboard against the shared
 * `kyc_verifications` row. Unlike the admin route this deliberately does NOT
 * stamp the dealer's first-API coupon (kyc_verification_metadata).
 *
 * Body: { rc_number?: string } — omitted falls back to personalDetails.vehicle_rc.
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 * Response: the admin `{ success, data, error }` shape (RCCard reads data.success
 * + data.data.rcDetails.chassisNumber + data.data.verificationId).
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeRcVerification } from "@/lib/kyc/rc-verification";

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
    let body: { rc_number?: unknown } = {};
    try {
      body = (await req.json()) as { rc_number?: unknown };
    } catch {
      body = {};
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        {
          success: false,
          error: { message: `FORBIDDEN: role '${actor.role}' cannot run verifications` },
        },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "No active assignment for this lead under this tenant" },
        },
        { status: 400 },
      );
    }

    const result = await executeRcVerification(leadId, {
      rcNumber: typeof body?.rc_number === "string" ? body.rc_number : undefined,
      applicant: "primary",
    });

    if (result.status) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: result.success,
      data: result.data,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
