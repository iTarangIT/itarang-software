import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { findResumableApplication, isMissingTable } from "@/lib/onboarding/resumeLookup";
import { deliverResumeOtp } from "@/lib/onboarding/resumeOtpDelivery";
import { resumeOtpMobile, resumeOtpSentWhere } from "@/lib/onboarding/resumeOtpChannel";
import {
  generateResumeOtp,
  hashResumeOtp,
  RESUME_OTP_MAX_SENDS,
  RESUME_OTP_SEND_WINDOW_MS,
  RESUME_OTP_TTL_MS,
  verifyResumeToken,
} from "@/lib/onboarding/submitAccess";

/**
 * POST /api/dealer/onboarding/resume/send-otp — tracker ID 129.
 *   { applicationId?, ownerEmail?, dealerCode? }
 *
 * A dealer with no login wants to continue an application that already exists.
 * This sends a one-time code to the owner MOBILE on the application by SMS
 * (ID 166 decision 5, 16 Oct; 2Factor → MSG91 → a 2Factor voice call), and to
 * the owner e-mail on the application when there is no usable mobile or every
 * SMS provider fails — never to a number or address the request supplies; the
 * typed e-mail is only used to find the application. Entering the code
 * (verify-otp) yields the resume token the submit route accepts. OTP_DRY_RUN=1
 * writes the code to the server log and sends nothing.
 *
 * Public by necessity (the dealer has no account). Throttled per IP and per
 * application, and it reveals nothing the submit route's 409 did not already:
 * that an application exists, and a masked address.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE =
  "Continuing an application by code is not available yet. Please contact your iTarang sales contact.";

export async function POST(req: NextRequest) {
  try {
    if (!takeIpToken(clientIp(req))) {
      return NextResponse.json(
        { success: false, message: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    // A caller already holding a valid token does not need another code.
    if (verifyResumeToken(str(body?.resumeToken))) {
      return NextResponse.json({ success: true, alreadyVerified: true });
    }

    const application = await findResumableApplication({
      applicationId: str(body?.applicationId),
      ownerEmail: str(body?.ownerEmail),
      dealerCode: str(body?.dealerCode),
    });
    const hasMobile = !!resumeOtpMobile(application?.owner_phone);
    const hasEmail = !!(application?.owner_email ?? "").trim();
    if (!application || (!hasMobile && !hasEmail)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "We could not find an application to continue, or it has no mobile number or email on file. Please contact your iTarang sales contact.",
        },
        { status: 404 },
      );
    }

    const since = new Date(Date.now() - RESUME_OTP_SEND_WINDOW_MS).toISOString();
    const [sent] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM dealer_onboarding_resume_otps
         WHERE application_id = ${application.id}::uuid AND created_at > ${since}::timestamptz
    `)) as unknown as Array<{ n: number }>;
    if ((sent?.n ?? 0) >= RESUME_OTP_MAX_SENDS) {
      return NextResponse.json(
        {
          success: false,
          message: "Too many codes were requested for this application. Please try again in 30 minutes.",
        },
        { status: 429 },
      );
    }

    const code = generateResumeOtp();
    const expiresAt = new Date(Date.now() + RESUME_OTP_TTL_MS);
    // One live code per application: an earlier one stops working.
    await db.execute(sql`
        UPDATE dealer_onboarding_resume_otps SET consumed_at = now()
         WHERE application_id = ${application.id}::uuid AND consumed_at IS NULL
    `);
    const delivery = await deliverResumeOtp({
      ownerPhone: application.owner_phone,
      ownerEmail: application.owner_email,
      ownerName: application.owner_name,
      companyName: application.company_name,
      code,
      expiresAt,
    });
    if (!delivery.ok) {
      console.error("[onboarding/resume/send-otp] not delivered:", delivery.errors.join("; "));
      return NextResponse.json(
        { success: false, message: "We couldn't send the code. Please try again in a few minutes." },
        { status: 502 },
      );
    }
    // Stored only once it went out, with where it went (mobile or email).
    await db.execute(sql`
        INSERT INTO dealer_onboarding_resume_otps (application_id, code_hash, sent_to, expires_at)
        VALUES (${application.id}::uuid, ${hashResumeOtp(application.id, code)}, ${delivery.sentTo},
                ${expiresAt.toISOString()}::timestamptz)
    `);

    return NextResponse.json({
      success: true,
      applicationId: application.id,
      channel: delivery.channel === "dev" ? (hasMobile ? "sms" : "email") : delivery.channel,
      sentTo: delivery.maskedTo,
      sentWhere: resumeOtpSentWhere(
        delivery.channel === "dev" ? (hasMobile ? "sms" : "email") : delivery.channel,
        delivery.maskedTo,
      ),
      expiresInSeconds: Math.round(RESUME_OTP_TTL_MS / 1000),
    });
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json({ success: false, message: UNAVAILABLE }, { status: 503 });
    }
    console.error("[onboarding/resume/send-otp]", err);
    return NextResponse.json(
      { success: false, message: "Could not send the code. Please try again." },
      { status: 500 },
    );
  }
}
