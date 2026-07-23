/**
 * POST /api/nbfc/acquire/[leadId]/kyc/coborrower/aadhaar/digilocker/initiate
 *
 * NBFC mirror of the admin co-borrower-Aadhaar DigiLocker initiate route
 * (src/app/api/admin/kyc/[leadId]/coborrower/aadhaar/digilocker/initiate/route.ts).
 * Reuses the shared executeCoBorrowerDigilockerInit service. NBFC auth
 * (resolveActor + role gate + active assignment); no coupon side-effect.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCoBorrowerDigilockerInit } from "@/lib/kyc/coborrower-verification";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

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
    const body = await req.json().catch(() => ({}));

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

    // Resolve redirect_url through the same safe-host helper primary uses.
    // publicOrigin rejects localhost / ngrok / .local in production and falls
    // back to validated request headers.
    let callbackUrl: string;
    try {
      const callbackBase = publicOrigin({ req });
      callbackUrl =
        body.redirect_url ||
        `${callbackBase}/api/kyc/digilocker/callback/coborrower/${encodeURIComponent(leadId)}`;
    } catch (err) {
      if (err instanceof PublicOriginError) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message:
                "Cannot initiate DigiLocker: no safe callback URL available. " +
                "Ask ops to set NEXT_PUBLIC_APP_URL to the deployed origin.",
              code: err.code,
            },
          },
          { status: 500 },
        );
      }
      throw err;
    }

    const result = await executeCoBorrowerDigilockerInit(leadId, {
      phone: body.phone,
      email: body.email,
      redirect_url: callbackUrl,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[NBFC Co-Borrower DigiLocker Init] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to initiate co-borrower DigiLocker session";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
