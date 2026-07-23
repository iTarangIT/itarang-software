/**
 * POST /api/nbfc/acquire/[leadId]/kyc/aadhaar/digilocker/initiate
 *
 * NBFC mirror of the admin primary-Aadhaar DigiLocker initiate route
 * (src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts).
 * Drives the exact same DigiLocker flow against the shared lead so the
 * AadhaarCard works on the NBFC Acquire surface. NBFC auth (resolveActor +
 * role gate + active assignment); no coupon side-effect.
 *
 * Note: the NBFC actor's initiate sends a DigiLocker SMS to the CUSTOMER —
 * intended (product decision).
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeDigilockerInitiate } from "@/lib/kyc/digilocker";
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

    // publicOrigin applies a safe-host allow-list. Refuses ngrok / localhost
    // in production so a teammate's local dev tunnel can't get stored as a
    // Decentro callback URL.
    let callbackBase: string;
    try {
      callbackBase = publicOrigin({ req });
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

    const result = await executeDigilockerInitiate(leadId, {
      callbackBase,
      notificationChannel:
        typeof body.notification_channel === "string"
          ? body.notification_channel
          : undefined,
      linkValidityHours:
        typeof body.link_validity_hours === "number"
          ? body.link_validity_hours
          : undefined,
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[NBFC DigiLocker Initiate] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to initiate DigiLocker";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
