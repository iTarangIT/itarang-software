import { NextRequest, NextResponse } from "next/server";

import { executeDigilockerResendSms } from "@/lib/kyc/digilocker";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

/**
 * Resend the DigiLocker SMS for the customer WITHOUT recreating the
 * Decentro DigiLocker session (which would cost a second credit and issue
 * a new URL). Picks the most recent non-terminal transaction for this lead
 * whose session hasn't expired and pushes a fresh SMS with the same URL.
 *
 * Returns:
 *   - 200 with { smsStatus, smsAttempts } on success/failed-delivery
 *   - 404 if no eligible transaction found
 *   - 410 if the matching session has expired (UI should fall back to full re-initiate)
 */
export async function POST(
  _req: NextRequest,
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
    const result = await executeDigilockerResendSms(leadId);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[DigiLocker Resend-SMS] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to resend SMS";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
