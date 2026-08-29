import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, passwordResetTokens } from "@/lib/db/schema";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashPassword } from "@/lib/auth/hashPassword";
import { log } from "@/lib/log";
import { hashResetToken, maskEmail } from "@/lib/auth/reset-token";

/**
 * GET  /api/auth/reset-password?token=<raw>  — validate a link on page load.
 * POST /api/auth/reset-password              — commit the new password.
 *
 * E-212. See drizzle/E-212_password_reset_tokens.sql for why we own the token
 * instead of using Supabase's recovery link: this app has TWO password stores
 * and one endpoint has to write both in a known order.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenError =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "EXPIRED"
  | "USED"
  | "SUPERSEDED";

/** Read-only classification of a token, shared by GET and POST's failure path. */
async function classify(rawToken: string): Promise<
  | { ok: true; row: { id: string; user_id: string; email: string; expires_at: Date } }
  | { ok: false; error: TokenError }
> {
  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      user_id: passwordResetTokens.user_id,
      email: passwordResetTokens.email,
      expires_at: passwordResetTokens.expires_at,
      used_at: passwordResetTokens.used_at,
      invalidated_at: passwordResetTokens.invalidated_at,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token_hash, hashResetToken(rawToken)))
    .limit(1);

  if (!row) return { ok: false, error: "INVALID_TOKEN" };
  if (row.used_at) return { ok: false, error: "USED" };
  if (row.invalidated_at) return { ok: false, error: "SUPERSEDED" };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: "EXPIRED" };
  }
  return {
    ok: true,
    row: {
      id: row.id,
      user_id: row.user_id,
      email: row.email,
      expires_at: row.expires_at,
    },
  };
}

/**
 * Validate-on-load. STRICTLY READ-ONLY — never mutate here, or a link-preview
 * scanner (Outlook Safe Links, Slack/WhatsApp unfurl) would burn the token
 * before the human ever clicks it.
 *
 * Returns HTTP 200 with ok:false rather than a 4xx, matching the convention in
 * /api/admin/nbfc-requests/[id]/act, so the client's ok-branch is uniform.
 */
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token")?.trim();
    if (!token) {
      return NextResponse.json({ ok: false, error: "MISSING_TOKEN" });
    }

    const result = await classify(token);
    if (!result.ok) return NextResponse.json(result);

    return NextResponse.json({
      ok: true,
      // From the token row's own email column — no users join, so this endpoint
      // cannot be used to dump addresses. You must already hold a valid 256-bit
      // token to see even the masked form.
      email_masked: maskEmail(result.row.email),
      expires_at: result.row.expires_at,
    });
  } catch (err) {
    log.error("[RESET-PASSWORD] GET failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS" },
        { status: 400 },
      );
    }

    const { token, password } = (body ?? {}) as {
      token?: unknown;
      password?: unknown;
    };
    const rawToken = typeof token === "string" ? token.trim() : "";
    const newPassword = typeof password === "string" ? password : "";

    if (!rawToken || !newPassword) {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS" },
        { status: 400 },
      );
    }
    // Same floor as /login and Supabase's own default. Deliberately NOT
    // stricter than /change-password — a reset page with tougher rules lets a
    // user set a password on one surface that the other would have refused,
    // and the mismatch is invisible until someone complains.
    if (newPassword.length < 6) {
      return NextResponse.json(
        {
          ok: false,
          error: "WEAK_PASSWORD",
          message: "Password must be at least 6 characters.",
        },
        { status: 400 },
      );
    }

    // Claim the token ATOMICALLY, before touching any password store. The
    // conditional UPDATE ... RETURNING is the mutex: a double-submitted form or
    // a double-clicked button produces exactly one winner at the Postgres row
    // level, with no advisory locks and no transaction plumbing. The cost is
    // that if the Supabase write below then fails, the token is burned and the
    // user must request a fresh link — the right way for that failure to land.
    const [claimed] = await db
      .update(passwordResetTokens)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(passwordResetTokens.token_hash, hashResetToken(rawToken)),
          isNull(passwordResetTokens.used_at),
          isNull(passwordResetTokens.invalidated_at),
          gt(passwordResetTokens.expires_at, new Date()),
        ),
      )
      .returning({
        id: passwordResetTokens.id,
        user_id: passwordResetTokens.user_id,
        email: passwordResetTokens.email,
      });

    if (!claimed) {
      // Nothing claimed — re-read (read-only) to report the precise reason.
      const why = await classify(rawToken);
      const error = why.ok ? "INVALID_TOKEN" : why.error;
      return NextResponse.json({ ok: false, error }, { status: 410 });
    }

    // SUPABASE FIRST — it is authoritative for login (login/page.tsx calls
    // signInWithPassword). Ordering rationale is the same as
    // /api/auth/change-password: Supabase-first means a subsequent RDS failure
    // still leaves the user ABLE TO SIGN IN (worst case a stale bcrypt mirror).
    // RDS-first would mean a Supabase failure locks them out entirely while the
    // mirror claims the new password works.
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      claimed.user_id,
      { password: newPassword },
    );

    if (supabaseError) {
      log.error("[RESET-PASSWORD] supabase update failed", {
        userId: claimed.user_id,
        err: supabaseError.message,
      });
      if (/at least|password/i.test(supabaseError.message)) {
        return NextResponse.json(
          { ok: false, error: "WEAK_PASSWORD", message: supabaseError.message },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          error: "UPDATE_FAILED",
          message: "Could not update your password. Contact it@itarang.com.",
        },
        { status: 500 },
      );
    }

    // RDS MIRROR SECOND. Matched on users.id — the token row carries the id, so
    // this flow never re-derives the user from a typed email and is
    // structurally immune to the mixed-case bug.
    //
    // must_change_password is cleared deliberately: middleware bounces
    // nbfc_partner users with the flag set to /change-password on every /nbfc
    // navigation, and the user most likely to click "Forgot password?" is an
    // NBFC partner who mislaid their activation credential. They have just
    // proven mailbox control AND chosen their own password — exactly the
    // condition the flag exists to force.
    const updated = await db
      .update(users)
      .set({
        password_hash: await hashPassword(newPassword),
        must_change_password: false,
        updated_at: new Date(),
      })
      .where(eq(users.id, claimed.user_id))
      .returning({ id: users.id });

    if (updated.length === 0) {
      // Still a 200: the Supabase write succeeded, so the password genuinely
      // did change and telling the user it failed would be false.
      log.error("[RESET-PASSWORD] no users row for auth id — mirror not written", {
        userId: claimed.user_id,
        email: claimed.email,
      });
    }

    log.info("[RESET-PASSWORD] password reset completed", {
      userId: claimed.user_id,
      email: claimed.email,
    });

    return NextResponse.json({
      ok: true,
      message: "Password updated. Please sign in with your new password.",
    });
  } catch (err) {
    log.error("[RESET-PASSWORD] unexpected error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "UPDATE_FAILED" },
      { status: 500 },
    );
  }
}
