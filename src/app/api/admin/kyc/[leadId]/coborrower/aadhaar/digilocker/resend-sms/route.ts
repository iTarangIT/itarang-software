import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycVerifications } from "@/lib/db/schema";
import { buildDigilockerSmsMessage } from "@/lib/decentro";
import { sendKycSms } from "@/lib/sms";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

/**
 * Co-borrower variant of the DigiLocker resend-sms endpoint.
 *
 * Unlike the primary flow (which records sessions in `digilocker_transactions`),
 * the co-borrower DigiLocker session is stored inside
 * `kyc_verifications.api_response.data` keyed by
 * (lead_id, verification_type='aadhaar', applicant='co_borrower'). This handler
 * picks the latest such row, pulls the saved `digilocker_url` + `reference_id`
 * out of api_response, and pushes a fresh SMS to the co-borrower's phone
 * without burning a second Decentro credit.
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
    const now = new Date();

    // Latest co-borrower Aadhaar verification on this lead
    const [ver] = await db
      .select()
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "aadhaar"),
          eq(kycVerifications.applicant, "co_borrower"),
        ),
      )
      .orderBy(desc(kycVerifications.created_at))
      .limit(1);

    if (!ver) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "No active co-borrower DigiLocker session to resend. Create a fresh link first.",
          },
        },
        { status: 404 },
      );
    }

    const apiResponse = (ver.api_response ?? {}) as Record<string, unknown>;
    const data = (apiResponse.data ?? {}) as Record<string, unknown>;
    const digilocker_url = typeof data.digilocker_url === "string" ? data.digilocker_url : null;
    const reference_id =
      typeof data.reference_id === "string" ? data.reference_id : `CB-RESEND-${ver.id}`;

    if (!digilocker_url) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "DigiLocker URL missing on this co-borrower verification — create a fresh link.",
          },
        },
        { status: 404 },
      );
    }

    // Pull the co-borrower's phone for the SMS target
    const [cb] = await db
      .select({ phone: coBorrowers.phone })
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);

    const phone = cb?.phone ?? "";
    if (!phone) {
      return NextResponse.json(
        { success: false, error: { message: "Co-borrower phone is missing." } },
        { status: 400 },
      );
    }

    // Co-borrower flow doesn't persist explicit expiry — Decentro DigiLocker
    // sessions are typically valid for 24h, so use that for the SMS body.
    const remainingHours = 24;

    const smsAttempts = typeof data.sms_attempts === "number" ? data.sms_attempts : 0;
    const attempt = smsAttempts + 1;
    const smsResult = await sendKycSms({
      mobile_number: phone,
      message: buildDigilockerSmsMessage(digilocker_url, remainingHours),
      reference_id: `${reference_id}-RESEND-${attempt}`,
      templateParams: [digilocker_url, String(remainingHours)],
    });

    // Mirror the primary handler: bump the counter so the UI reflects the retry
    // even on delivery failure. Keeps retry accounting honest.
    const updatedData: Record<string, unknown> = {
      ...data,
      sms_attempts: attempt,
      sms_message_id: smsResult.messageId ?? data.sms_message_id ?? null,
      sms_delivered_at: smsResult.success ? now.toISOString() : (data.sms_delivered_at ?? null),
      sms_failed_reason: smsResult.success ? null : (smsResult.error ?? "unknown"),
    };
    await db
      .update(kycVerifications)
      .set({
        api_response: { ...apiResponse, data: updatedData },
        updated_at: now,
      })
      .where(eq(kycVerifications.id, ver.id));

    const smsStatus = smsResult.success
      ? "delivered"
      : smsResult.skipped
        ? "skipped"
        : "failed";

    return NextResponse.json({
      success: smsResult.success,
      data: {
        verificationId: ver.id,
        smsStatus,
        smsStatusMessage: smsResult.error,
        smsMessageId: smsResult.messageId,
        smsAttempts: attempt,
      },
      ...(smsResult.success
        ? {}
        : {
            error: {
              message: smsResult.skipped
                ? "SMS provider is not enabled on this deploy. Copy the link and share manually."
                : smsResult.error ?? "SMS resend failed",
            },
          }),
    });
  } catch (error) {
    console.error("[Co-Borrower DigiLocker Resend-SMS] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to resend SMS";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
