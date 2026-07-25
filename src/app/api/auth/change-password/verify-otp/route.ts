import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { passwordChangeOtps } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import {
  hashOtp,
  OTP_FORMAT_RE,
  OTP_LENGTH,
  OTP_LOCK_MS,
  OTP_MAX_ATTEMPTS,
} from "@/lib/auth/password-change-otp";

/**
 * POST /api/auth/change-password/verify-otp — E-213.
 *
 * Checks the emailed code and stamps `verified_at`. Does NOT change the
 * password — that is the separate `confirm` step, so the user can be shown the
 * new-password form only after proving mailbox control.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED", message: "Please sign in again." },
        { status: 401 },
      );
    }

    if (!takeIpToken(clientIp(req))) {
      return NextResponse.json(
        {
          ok: false,
          error: "RATE_LIMITED",
          message: "Too many requests. Please try again in a few minutes.",
        },
        { status: 429 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS", message: "No code supplied." },
        { status: 400 },
      );
    }
    const raw = (body as { otp?: unknown } | null)?.otp;
    const otp = typeof raw === "string" ? raw.trim() : "";

    const now = new Date();

    // Sessions are scoped by user_id, so one user can never verify another's
    // code — a mismatched caller simply has no open row.
    const [session] = await db
      .select()
      .from(passwordChangeOtps)
      .where(
        and(
          eq(passwordChangeOtps.user_id, authUser.id),
          isNull(passwordChangeOtps.verified_at),
          isNull(passwordChangeOtps.consumed_at),
        ),
      )
      .orderBy(desc(passwordChangeOtps.created_at))
      .limit(1);

    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          error: "NO_ACTIVE_OTP",
          message: "No active code. Please request a new one.",
        },
        { status: 400 },
      );
    }

    if (session.locked_until && now < session.locked_until) {
      const retryAfterMinutes = Math.ceil(
        (session.locked_until.getTime() - now.getTime()) / 60_000,
      );
      return NextResponse.json(
        {
          ok: false,
          error: "LOCKED",
          retryAfterMinutes,
          message: `Too many incorrect attempts. Try again in ${retryAfterMinutes} minute(s).`,
        },
        { status: 429 },
      );
    }

    if (now >= session.expires_at) {
      return NextResponse.json(
        {
          ok: false,
          error: "EXPIRED",
          message: "That code has expired. Please request a new one.",
        },
        { status: 400 },
      );
    }

    // Malformed input is a typo, not a guess — it must not burn an attempt,
    // or a user fat-fingering a letter would lock themselves out.
    if (!OTP_FORMAT_RE.test(otp)) {
      return NextResponse.json(
        {
          ok: false,
          error: "INVALID_FORMAT",
          message: `Enter the ${OTP_LENGTH}-digit code from your email.`,
        },
        { status: 400 },
      );
    }

    if (session.otp_hash !== hashOtp(otp)) {
      const attempts = session.attempt_count + 1;
      const locked = attempts >= OTP_MAX_ATTEMPTS;
      await db
        .update(passwordChangeOtps)
        .set({
          attempt_count: attempts,
          updated_at: now,
          ...(locked
            ? { locked_until: new Date(now.getTime() + OTP_LOCK_MS) }
            : {}),
        })
        .where(eq(passwordChangeOtps.id, session.id));

      const attemptsRemaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
      log.warn("[CHANGE-PASSWORD-OTP] incorrect code", {
        userId: authUser.id,
        attempts,
        locked,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "INCORRECT_OTP",
          attemptsRemaining,
          message: locked
            ? `Incorrect code. Too many attempts — locked for ${Math.round(OTP_LOCK_MS / 60_000)} minutes.`
            : `Incorrect code. ${attemptsRemaining} attempt(s) remaining.`,
        },
        { status: 400 },
      );
    }

    // Conditional so a double-submitted form can only stamp it once.
    const [verified] = await db
      .update(passwordChangeOtps)
      .set({ verified_at: now, updated_at: now })
      .where(
        and(
          eq(passwordChangeOtps.id, session.id),
          isNull(passwordChangeOtps.verified_at),
        ),
      )
      .returning({ id: passwordChangeOtps.id });

    if (!verified) {
      return NextResponse.json(
        {
          ok: false,
          error: "NO_ACTIVE_OTP",
          message: "No active code. Please request a new one.",
        },
        { status: 400 },
      );
    }

    log.info("[CHANGE-PASSWORD-OTP] code verified", { userId: authUser.id });

    return NextResponse.json({
      ok: true,
      expiresInSeconds: Math.max(
        0,
        Math.round((session.expires_at.getTime() - now.getTime()) / 1000),
      ),
    });
  } catch (err) {
    log.error("[CHANGE-PASSWORD-OTP] verify unexpected error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR", message: "Something went wrong." },
      { status: 500 },
    );
  }
}
