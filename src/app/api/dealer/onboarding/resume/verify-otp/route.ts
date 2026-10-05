import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { findResumableApplication, isMissingTable } from "@/lib/onboarding/resumeLookup";
import {
  hashResumeOtp,
  RESUME_OTP_FORMAT_RE,
  RESUME_OTP_MAX_ATTEMPTS,
  RESUME_TOKEN_TTL_MS,
  signResumeToken,
} from "@/lib/onboarding/submitAccess";

/**
 * POST /api/dealer/onboarding/resume/verify-otp — tracker ID 129.
 *   { applicationId?, ownerEmail?, dealerCode?, code }
 *
 * Checks the code send-otp mailed. Right code → a resume token for that one
 * application, valid 30 minutes, which POST /api/dealer/onboarding/submit
 * accepts as proof of ownership. A code works once and dies after five wrong
 * entries.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WRONG = "That code is not right, or it has expired. Check the email, or request a new code.";
const UNAVAILABLE =
  "Continuing an application by email code is not available yet. Please contact your iTarang sales contact.";

export async function POST(req: NextRequest) {
  try {
    if (!takeIpToken(clientIp(req))) {
      return NextResponse.json(
        { success: false, message: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const code = (str(body?.code) ?? "").trim();
    // Malformed input is refused without burning an attempt.
    if (!RESUME_OTP_FORMAT_RE.test(code)) {
      return NextResponse.json(
        { success: false, message: "Enter the 6-digit code from the email." },
        { status: 400 },
      );
    }

    const application = await findResumableApplication({
      applicationId: str(body?.applicationId),
      ownerEmail: str(body?.ownerEmail),
      dealerCode: str(body?.dealerCode),
    });
    if (!application) return NextResponse.json({ success: false, message: WRONG }, { status: 400 });

    const [otp] = (await db.execute(sql`
        SELECT id::text AS id, code_hash, attempts
          FROM dealer_onboarding_resume_otps
         WHERE application_id = ${application.id}::uuid
           AND consumed_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1
    `)) as unknown as Array<{ id: string; code_hash: string; attempts: number }>;
    if (!otp || otp.attempts >= RESUME_OTP_MAX_ATTEMPTS) {
      return NextResponse.json({ success: false, message: WRONG }, { status: 400 });
    }

    const want = Buffer.from(otp.code_hash);
    const got = Buffer.from(hashResumeOtp(application.id, code));
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      await db.execute(sql`
          UPDATE dealer_onboarding_resume_otps SET attempts = attempts + 1 WHERE id = ${otp.id}::uuid
      `);
      return NextResponse.json({ success: false, message: WRONG }, { status: 400 });
    }

    // Used once: the UPDATE only succeeds for the first caller.
    const used = (await db.execute(sql`
        UPDATE dealer_onboarding_resume_otps SET consumed_at = now()
         WHERE id = ${otp.id}::uuid AND consumed_at IS NULL
        RETURNING id
    `)) as unknown as unknown[];
    const resumeToken = used.length ? signResumeToken(application.id) : null;
    if (!resumeToken) return NextResponse.json({ success: false, message: WRONG }, { status: 400 });

    return NextResponse.json({
      success: true,
      applicationId: application.id,
      resumeToken,
      expiresInSeconds: Math.round(RESUME_TOKEN_TTL_MS / 1000),
    });
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json({ success: false, message: UNAVAILABLE }, { status: 503 });
    }
    console.error("[onboarding/resume/verify-otp]", err);
    return NextResponse.json(
      { success: false, message: "Could not check the code. Please try again." },
      { status: 500 },
    );
  }
}
