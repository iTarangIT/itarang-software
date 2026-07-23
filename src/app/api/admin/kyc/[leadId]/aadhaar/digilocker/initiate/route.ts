import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeDigilockerInitiate } from "@/lib/kyc/digilocker";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

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

    // publicOrigin applies a safe-host allow-list. Refuses ngrok / localhost
    // in production so a teammate's local dev tunnel can't get stored as a
    // Decentro callback URL (see 2026-04-23 incident in src/lib/public-origin.ts).
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
      // Admin initiate consumes the dealer's first-API coupon (BRD §1).
      stampCoupon: true,
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[DigiLocker Initiate] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to initiate DigiLocker";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
