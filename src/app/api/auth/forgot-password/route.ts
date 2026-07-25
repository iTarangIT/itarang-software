import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, passwordResetTokens } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { PublicOriginError } from "@/lib/public-origin";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { sendPasswordResetEmail } from "@/lib/email/sendPasswordResetEmail";
import {
  buildResetLink,
  generateResetToken,
  resetTokenExpiry,
  PASSWORD_RESET_TTL_MS,
  RESET_MAX_PER_WINDOW,
  RESET_MIN_INTERVAL_MS,
  RESET_RETENTION_MS,
  RESET_WINDOW_MS,
} from "@/lib/auth/reset-token";

/**
 * POST /api/auth/forgot-password — E-212.
 *
 * Issues a single-use reset token and emails the link.
 *
 * ENUMERATION CONTRACT: this endpoint returns the SAME 200 body for every
 * outcome — match, no match, inactive account, throttled, and even a mail-send
 * failure. Nothing a caller can observe may reveal whether an address is
 * registered. That includes timing, which is why the no-match path sleeps (see
 * below), and it includes the throttle, which is silent because a throttle
 * response could only ever be produced for an account that EXISTS.
 *
 * The one stated tradeoff: if AgentMail is down we tell the user to check an
 * inbox that will never receive anything. Returning 502 instead would leak
 * existence, because a send is only attempted for a real account. The
 * mitigation is operational — the log.error below, plus the "nothing in your
 * inbox? contact us" line in the modal's sent state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_OK = {
  ok: true as const,
  message: "If an account exists for this email, a reset link has been sent.",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "INVALID_EMAIL" },
        { status: 400 },
      );
    }

    const raw = (body as { email?: unknown } | null)?.email;
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!email || !EMAIL_RE.test(email)) {
      // A malformed string is not an account, so refusing it leaks nothing.
      return NextResponse.json(
        { ok: false, error: "INVALID_EMAIL" },
        { status: 400 },
      );
    }

    // Per-IP limiter BEFORE any DB work, so a sweep is cheap to refuse.
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

    // Case-insensitive lookup. lower() on BOTH sides is mandatory: Supabase
    // Auth lower-cases emails while users.email can be mixed-case from
    // onboarding, and Postgres `=` is case-sensitive — a plain
    // eq(users.email, email) silently matches zero rows. This is the exact bug
    // documented at src/app/api/auth/change-password/route.ts:46-50.
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        is_active: users.is_active,
      })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .limit(2);

    if (rows.length > 1) {
      log.warn("[FORGOT-PASSWORD] multiple users share this email", { email });
    }
    const user = rows.find((r) => r.is_active) ?? rows[0];

    if (!user || !user.is_active) {
      log.info("[FORGOT-PASSWORD] no active account", { email, ip });
      // Timing-oracle patch: the match path pays a DB write plus a ~300-1500ms
      // AgentMail POST, so an instant no-match reply would be a trivially
      // measurable existence oracle.
      await sleep(400 + Math.floor(Math.random() * 800));
      return NextResponse.json(GENERIC_OK);
    }

    // Per-account throttle — durable and shared, unlike the per-IP Map.
    // SILENT by design (see the enumeration contract above).
    const now = new Date();
    const [recent] = await db
      .select({
        n: sql<number>`count(*)::int`,
        last: sql<Date | null>`max(${passwordResetTokens.created_at})`,
      })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.user_id, user.id),
          gt(
            passwordResetTokens.created_at,
            new Date(now.getTime() - RESET_WINDOW_MS),
          ),
        ),
      );

    const count = recent?.n ?? 0;
    const lastAt = recent?.last ? new Date(recent.last) : null;
    const tooSoon =
      lastAt !== null && now.getTime() - lastAt.getTime() < RESET_MIN_INTERVAL_MS;

    if (count >= RESET_MAX_PER_WINDOW || tooSoon) {
      log.warn("[FORGOT-PASSWORD] throttled", {
        userId: user.id,
        count,
        tooSoon,
      });
      return NextResponse.json(GENERIC_OK);
    }

    // One live link per account, always the newest. The common real sequence is
    // "click Share, nothing arrives in 20s, click Share again" — leaving both
    // live would mean two account-takeover credentials in flight for zero
    // benefit, and superseding lets the reset page say something actionable
    // ("a newer link was sent") instead of a generic failure.
    await db
      .update(passwordResetTokens)
      .set({ invalidated_at: now })
      .where(
        and(
          eq(passwordResetTokens.user_id, user.id),
          isNull(passwordResetTokens.used_at),
          isNull(passwordResetTokens.invalidated_at),
        ),
      );

    const { rawToken, tokenHash } = generateResetToken();
    const expiresAt = resetTokenExpiry(now);

    await db.insert(passwordResetTokens).values({
      user_id: user.id,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      requested_ip: ip.slice(0, 64),
      requested_ua: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    });

    // Opportunistic prune so the table cannot grow forever without a cron.
    // Its own try/catch — a prune failure must never fail a reset request.
    try {
      await db
        .delete(passwordResetTokens)
        .where(
          lt(
            passwordResetTokens.created_at,
            new Date(now.getTime() - RESET_RETENTION_MS),
          ),
        );
    } catch (pruneErr) {
      log.warn("[FORGOT-PASSWORD] prune failed", {
        err: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    }

    let url: string;
    try {
      url = buildResetLink(rawToken, req);
    } catch (originErr) {
      // publicOrigin refused to produce a link (unsafe host in a
      // production-like env). Send nothing rather than mail a real user a dead
      // tunnel/localhost URL — but still answer generically.
      if (originErr instanceof PublicOriginError) {
        log.error("[FORGOT-PASSWORD] no safe public origin — email NOT sent", {
          userId: user.id,
          code: originErr.code,
        });
        return NextResponse.json(GENERIC_OK);
      }
      throw originErr;
    }

    // How this flow gets tested without depending on mail delivery.
    if (process.env.NODE_ENV !== "production") {
      log.info("[FORGOT-PASSWORD] dev link", { url });
    }

    try {
      await sendPasswordResetEmail({
        toEmail: user.email,
        userName: user.name || "there",
        url,
        expiresAt,
      });
      log.info("[FORGOT-PASSWORD] reset link sent", {
        userId: user.id,
        ttlMinutes: PASSWORD_RESET_TTL_MS / 60_000,
      });
    } catch (mailErr) {
      // Loud server-side, generic to the caller. See the enumeration contract.
      log.error("[FORGOT-PASSWORD] SEND FAILED — user was told to check email", {
        userId: user.id,
        toEmail: user.email,
        err: mailErr instanceof Error ? mailErr.message : String(mailErr),
      });
    }

    return NextResponse.json(GENERIC_OK);
  } catch (err) {
    log.error("[FORGOT-PASSWORD] unexpected error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
