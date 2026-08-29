import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, passwordChangeOtps } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { maskEmail } from "@/lib/auth/reset-token";
import { sendPasswordChangeOtpEmail } from "@/lib/email/sendPasswordChangeOtpEmail";
import {
  generateOtp,
  hashOtp,
  otpExpiry,
  OTP_LENGTH,
  OTP_MAX_SENDS,
  OTP_RESEND_MIN_INTERVAL_MS,
  OTP_RETENTION_MS,
  OTP_SEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from "@/lib/auth/password-change-otp";

/**
 * POST /api/auth/change-password/send-otp — E-213.
 *
 * Mails a short-lived code to the signed-in user's REGISTERED address.
 *
 * The request body is empty on purpose: the email is read from `users` via the
 * session id and is NEVER accepted from the caller. That is what lets this
 * endpoint return real, specific errors — unlike /api/auth/forgot-password,
 * which is unauthenticated, takes an arbitrary address, and therefore has to
 * answer generically to avoid becoming an account-existence oracle. Here the
 * caller already IS the account: there is nothing to enumerate, so a vague
 * error would be a usability bug with no security benefit.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    // Deliberately NOT requireAuth() — that calls redirect("/login"), which
    // throws a Next redirect out of a fetch handler and gives the modal an
    // opaque failure instead of a 401 it can render.
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED", message: "Please sign in again." },
        { status: 401 },
      );
    }

    // Guards a brute-force loop from a compromised session. Reused unchanged
    // from the E-212 forgot-password flow.
    const ip = clientIp(req);
    if (!takeIpToken(ip)) {
      return NextResponse.json(
        {
          ok: false,
          error: "RATE_LIMITED",
          message: "Too many requests. Please try again in a few minutes.",
        },
        { status: 429 },
      );
    }

    const [me] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        is_active: users.is_active,
      })
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);

    if (!me) {
      log.error("[CHANGE-PASSWORD-OTP] no users row for auth id", {
        authId: authUser.id,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "NO_ACCOUNT",
          message: "Account record not found. Contact it@itarang.com.",
        },
        { status: 404 },
      );
    }
    if (!me.is_active) {
      return NextResponse.json(
        {
          ok: false,
          error: "ACCOUNT_INACTIVE",
          message: "Your account is inactive. Contact your administrator.",
        },
        { status: 403 },
      );
    }

    const now = new Date();

    // The one open (unverified, unconsumed) session for this user, if any.
    const [existing] = await db
      .select()
      .from(passwordChangeOtps)
      .where(
        and(
          eq(passwordChangeOtps.user_id, me.id),
          isNull(passwordChangeOtps.verified_at),
          isNull(passwordChangeOtps.consumed_at),
        ),
      )
      .orderBy(desc(passwordChangeOtps.created_at))
      .limit(1);

    let session = existing;

    if (session) {
      // Hard cap: MAX_SENDS codes, then a cooldown measured from the session's
      // start. Past the cooldown the stale session is retired and a fresh one
      // begins (same shape as consent-service's OTP cooldown).
      if (session.send_count >= OTP_MAX_SENDS) {
        const cutoff = new Date(
          session.created_at.getTime() + OTP_SEND_COOLDOWN_MS,
        );
        if (now < cutoff) {
          const retryAfterMinutes = Math.ceil(
            (cutoff.getTime() - now.getTime()) / 60_000,
          );
          log.warn("[CHANGE-PASSWORD-OTP] send limit hit", { userId: me.id });
          return NextResponse.json(
            {
              ok: false,
              error: "SEND_LIMIT",
              retryAfterMinutes,
              message: `Too many codes requested. Please wait ${retryAfterMinutes} minute(s) and try again.`,
            },
            { status: 429 },
          );
        }
        await db
          .update(passwordChangeOtps)
          .set({ consumed_at: now, updated_at: now })
          .where(eq(passwordChangeOtps.id, session.id));
        session = undefined;
      } else if (
        now.getTime() - session.updated_at.getTime() <
        OTP_RESEND_MIN_INTERVAL_MS
      ) {
        const retryAfterSeconds = Math.ceil(
          (OTP_RESEND_MIN_INTERVAL_MS -
            (now.getTime() - session.updated_at.getTime())) /
            1000,
        );
        return NextResponse.json(
          {
            ok: false,
            error: "TOO_SOON",
            retryAfterSeconds,
            message: `Please wait ${retryAfterSeconds}s before requesting another code.`,
          },
          { status: 429 },
        );
      }
    }

    const code = generateOtp();
    const expiresAt = otpExpiry(now);
    const normalizedEmail = me.email.trim().toLowerCase();

    // How this flow is tested without depending on mail delivery.
    if (process.env.NODE_ENV !== "production") {
      log.warn("[CHANGE-PASSWORD-OTP] dev code", { userId: me.id, code });
    }

    let deliveryStatus = "sent";
    try {
      await sendPasswordChangeOtpEmail({
        toEmail: me.email,
        userName: me.name || "there",
        code,
        expiresAt,
      });
    } catch (mailErr) {
      deliveryStatus = "failed";
      log.error("[CHANGE-PASSWORD-OTP] send failed", {
        userId: me.id,
        err: mailErr instanceof Error ? mailErr.message : String(mailErr),
      });
      // Report honestly — there is no account existence to protect here.
      // Still bump send_count so the cap stays truthful.
      if (session) {
        await db
          .update(passwordChangeOtps)
          .set({
            send_count: session.send_count + 1,
            delivery_status: deliveryStatus,
            updated_at: now,
          })
          .where(eq(passwordChangeOtps.id, session.id));
      }
      return NextResponse.json(
        {
          ok: false,
          error: "SEND_FAILED",
          message:
            "We couldn't send the code right now. Please try again, or contact it@itarang.com.",
        },
        { status: 502 },
      );
    }

    const otpHash = hashOtp(code);
    if (session) {
      // Reuse the row: a resend resets the attempt ladder and the deadline.
      await db
        .update(passwordChangeOtps)
        .set({
          otp_hash: otpHash,
          expires_at: expiresAt,
          send_count: session.send_count + 1,
          attempt_count: 0,
          locked_until: null,
          delivery_status: deliveryStatus,
          requested_ip: ip.slice(0, 64),
          requested_ua: req.headers.get("user-agent")?.slice(0, 500) ?? null,
          updated_at: now,
        })
        .where(eq(passwordChangeOtps.id, session.id));
    } else {
      await db.insert(passwordChangeOtps).values({
        user_id: me.id,
        email: normalizedEmail,
        otp_hash: otpHash,
        expires_at: expiresAt,
        delivery_status: deliveryStatus,
        requested_ip: ip.slice(0, 64),
        requested_ua: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      });
    }

    // Opportunistic prune, in its own try/catch — a prune failure must never
    // fail a send.
    try {
      await db
        .delete(passwordChangeOtps)
        .where(
          lt(
            passwordChangeOtps.created_at,
            new Date(now.getTime() - OTP_RETENTION_MS),
          ),
        );
    } catch (pruneErr) {
      log.warn("[CHANGE-PASSWORD-OTP] prune failed", {
        err: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    }

    const sendCount = session ? session.send_count + 1 : 1;
    log.info("[CHANGE-PASSWORD-OTP] code sent", { userId: me.id, sendCount });

    return NextResponse.json({
      ok: true,
      maskedEmail: maskEmail(me.email),
      expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
      sendCount,
      maxSends: OTP_MAX_SENDS,
      otpLength: OTP_LENGTH,
      // The code is never echoed back to the client — not even in dev. It goes
      // to the user's inbox and nowhere else.
    });
  } catch (err) {
    log.error("[CHANGE-PASSWORD-OTP] send unexpected error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR", message: "Something went wrong." },
      { status: 500 },
    );
  }
}
