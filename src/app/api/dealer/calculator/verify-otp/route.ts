import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";

import { db } from "@/lib/db";
import { calcOtpVerifications } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import { maskCalcPhone, normalizeCalcPhone } from "@/lib/calculator/whatsapp";

// Calculator OTP gate — verify. Hash-compares the entered OTP against the open
// session for (dealer user, phone). On success the session is stamped
// verified_at. The verification is SINGLE-USE: the calculate route consumes it
// on the first successful calculation, so every new search needs a fresh OTP.
// It also expires unused after 30 minutes (VERIFICATION_WINDOW_MS in the
// calculate route). Mirrors Step 5 confirm-dispatch: 3 attempts, 5-min lockout.

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 3;
const LOCK_MS = 5 * 60 * 1000;
const VERIFICATION_VALID_MINUTES = 30; // keep in sync with the calculate route's gate window

const bodySchema = z.object({
  phone: z.string().min(5, "Phone is required"),
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["dealer"]);
    const body = bodySchema.parse(await req.json());

    const phone = normalizeCalcPhone(body.phone);
    if (!phone) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Enter a valid 10-digit Indian mobile number.", code: "invalid_phone" },
        },
        { status: 400 },
      );
    }

    const [session] = await db
      .select()
      .from(calcOtpVerifications)
      .where(
        and(
          eq(calcOtpVerifications.createdBy, user.id),
          eq(calcOtpVerifications.phone, phone),
          isNull(calcOtpVerifications.verifiedAt),
          isNull(calcOtpVerifications.consumedAt),
        ),
      )
      .orderBy(desc(calcOtpVerifications.createdAt))
      .limit(1);

    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "No active OTP. Please request a new one.", code: "no_active_otp" },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    if (session.lockedUntil && now < session.lockedUntil) {
      const mins = Math.ceil((session.lockedUntil.getTime() - now.getTime()) / 60000);
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Too many attempts. Locked for ${mins} more minute(s).`,
            code: "locked",
          },
        },
        { status: 429 },
      );
    }
    if (now >= session.expiresAt) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "OTP expired. Please resend.", code: "expired" },
        },
        { status: 400 },
      );
    }

    if (session.otpHash !== hashOtp(body.otp)) {
      const attempts = session.attemptCount + 1;
      await db
        .update(calcOtpVerifications)
        .set({
          attemptCount: attempts,
          ...(attempts >= MAX_ATTEMPTS ? { lockedUntil: new Date(now.getTime() + LOCK_MS) } : {}),
        })
        .where(eq(calcOtpVerifications.id, session.id));
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              attempts >= MAX_ATTEMPTS
                ? "Incorrect OTP. Too many attempts — locked for 5 minutes."
                : `Incorrect OTP. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
            code: "wrong_otp",
          },
        },
        { status: 400 },
      );
    }

    await db
      .update(calcOtpVerifications)
      .set({ verifiedAt: now })
      .where(eq(calcOtpVerifications.id, session.id));

    return NextResponse.json({
      success: true,
      data: {
        verified: true,
        verificationId: session.id,
        phone: maskCalcPhone(phone),
        validForMinutes: VERIFICATION_VALID_MINUTES,
      },
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: error.issues[0]?.message ?? "Invalid request" } },
        { status: 400 },
      );
    }
    console.error("[Calculator Verify OTP] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to verify OTP";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
