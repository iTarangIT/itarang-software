import { timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { ResumableApplication } from "@/lib/onboarding/resumeLookup";
import { deliverResumeOtp } from "@/lib/onboarding/resumeOtpDelivery";
import { resumeOtpMobile, resumeOtpSentWhere } from "@/lib/onboarding/resumeOtpChannel";
import {
  generateResumeOtp,
  hashResumeOtp,
  RESUME_OTP_FORMAT_RE,
  RESUME_OTP_MAX_ATTEMPTS,
  RESUME_OTP_MAX_SENDS,
  RESUME_OTP_SEND_WINDOW_MS,
  RESUME_OTP_TTL_MS,
  signResumeToken,
} from "@/lib/onboarding/submitAccess";

// The one-time code a dealer with no login gets on the owner mobile (or the
// owner e-mail when there is no usable mobile) to prove an application is its
// own (ID 129, ID 166 decision 5). Used by the resume flow
// (/api/dealer/onboarding/resume/*) and, since ID 166-C, by the correction
// link before it shows any earlier document (/api/onboarding/correct/[token]/code).
// The code always goes to the address ON THE APPLICATION, never to one the
// caller supplies.

export type CodeResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; message: string };

/** Send a fresh code for `application`. One live code per application; throttled per application. */
export async function sendResumeCode(application: ResumableApplication): Promise<CodeResult> {
  const hasMobile = !!resumeOtpMobile(application.owner_phone);
  const hasEmail = !!(application.owner_email ?? "").trim();
  if (!hasMobile && !hasEmail) {
    return {
      ok: false,
      status: 404,
      message:
        "This application has no mobile number or email on file. Please contact your iTarang sales contact.",
    };
  }

  const since = new Date(Date.now() - RESUME_OTP_SEND_WINDOW_MS).toISOString();
  const [sent] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dealer_onboarding_resume_otps
       WHERE application_id = ${application.id}::uuid AND created_at > ${since}::timestamptz
  `)) as unknown as Array<{ n: number }>;
  if ((sent?.n ?? 0) >= RESUME_OTP_MAX_SENDS) {
    return {
      ok: false,
      status: 429,
      message: "Too many codes were requested for this application. Please try again in 30 minutes.",
    };
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
    console.error("[onboarding/resume-code] not delivered:", delivery.errors.join("; "));
    return { ok: false, status: 502, message: "We couldn't send the code. Please try again in a few minutes." };
  }
  // Stored only once it went out, with where it went (mobile or email).
  await db.execute(sql`
      INSERT INTO dealer_onboarding_resume_otps (application_id, code_hash, sent_to, expires_at)
      VALUES (${application.id}::uuid, ${hashResumeOtp(application.id, code)}, ${delivery.sentTo},
              ${expiresAt.toISOString()}::timestamptz)
  `);

  const channel = delivery.channel === "dev" ? (hasMobile ? "sms" : "email") : delivery.channel;
  return {
    ok: true,
    body: {
      applicationId: application.id,
      channel,
      sentTo: delivery.maskedTo,
      sentWhere: resumeOtpSentWhere(channel, delivery.maskedTo),
      expiresInSeconds: Math.round(RESUME_OTP_TTL_MS / 1000),
    },
  };
}

export const WRONG_CODE =
  "That code is not right, or it has expired. Check the SMS (or email), or request a new code.";

/**
 * Check `code` for application `applicationId`. Right code → a resume token
 * (30 minutes) for that application; the code works once and dies after five
 * wrong entries. Malformed input is refused without burning an attempt.
 */
export async function checkResumeCode(
  applicationId: string,
  rawCode: unknown,
): Promise<{ ok: true; resumeToken: string } | { ok: false; status: number; message: string }> {
  const code = (typeof rawCode === "string" ? rawCode : "").trim();
  if (!RESUME_OTP_FORMAT_RE.test(code)) {
    return { ok: false, status: 400, message: "Enter the 6-digit code we sent you." };
  }

  const [otp] = (await db.execute(sql`
      SELECT id::text AS id, code_hash, attempts
        FROM dealer_onboarding_resume_otps
       WHERE application_id = ${applicationId}::uuid
         AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
  `)) as unknown as Array<{ id: string; code_hash: string; attempts: number }>;
  if (!otp || otp.attempts >= RESUME_OTP_MAX_ATTEMPTS) {
    return { ok: false, status: 400, message: WRONG_CODE };
  }

  const want = Buffer.from(otp.code_hash);
  const got = Buffer.from(hashResumeOtp(applicationId, code));
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    await db.execute(sql`
        UPDATE dealer_onboarding_resume_otps SET attempts = attempts + 1 WHERE id = ${otp.id}::uuid
    `);
    return { ok: false, status: 400, message: WRONG_CODE };
  }

  // Used once: the UPDATE only succeeds for the first caller.
  const used = (await db.execute(sql`
      UPDATE dealer_onboarding_resume_otps SET consumed_at = now()
       WHERE id = ${otp.id}::uuid AND consumed_at IS NULL
      RETURNING id
  `)) as unknown as unknown[];
  const resumeToken = used.length ? signResumeToken(applicationId) : null;
  if (!resumeToken) return { ok: false, status: 400, message: WRONG_CODE };
  return { ok: true, resumeToken };
}
