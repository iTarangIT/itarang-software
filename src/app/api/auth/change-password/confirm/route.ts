import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, passwordChangeOtps } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashPassword } from "@/lib/auth/hashPassword";
import { log } from "@/lib/log";

/**
 * POST /api/auth/change-password/confirm — E-213.
 *
 * Commits the new password. Takes ONLY `{ password }`: the verified OTP row is
 * the authorisation, and there is deliberately no current-password field (the
 * product decision is that control of the registered mailbox is the proof).
 *
 * The core security assertion this endpoint upholds: a valid session ALONE
 * cannot change a password. Without a verified-and-unconsumed OTP row the
 * atomic claim below matches nothing and the request 410s.
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS", message: "No password supplied." },
        { status: 400 },
      );
    }
    const raw = (body as { password?: unknown } | null)?.password;
    const password = typeof raw === "string" ? raw : "";

    if (!password) {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS", message: "No password supplied." },
        { status: 400 },
      );
    }
    // Same floor as /change-password and /api/auth/reset-password, on purpose.
    // A surface with stricter rules than its siblings lets a user set a
    // password on one screen that another would have refused, and the mismatch
    // is invisible until someone complains.
    if (password.length < 6) {
      return NextResponse.json(
        {
          ok: false,
          error: "WEAK_PASSWORD",
          message: "Password must be at least 6 characters.",
        },
        { status: 400 },
      );
    }

    const now = new Date();

    // Atomic single-use claim. The conditional UPDATE ... RETURNING is the
    // mutex: a double-clicked submit produces exactly one winner at the
    // Postgres row level, with no advisory locks and no transaction plumbing.
    const [claimed] = await db
      .update(passwordChangeOtps)
      .set({ consumed_at: now, updated_at: now })
      .where(
        and(
          eq(passwordChangeOtps.user_id, authUser.id),
          isNotNull(passwordChangeOtps.verified_at),
          isNull(passwordChangeOtps.consumed_at),
          gt(passwordChangeOtps.expires_at, now),
        ),
      )
      .returning({
        id: passwordChangeOtps.id,
        user_id: passwordChangeOtps.user_id,
        email: passwordChangeOtps.email,
      });

    if (!claimed) {
      return NextResponse.json(
        {
          ok: false,
          error: "NOT_VERIFIED",
          message:
            "Your verification has expired or was already used. Please start again.",
        },
        { status: 410 },
      );
    }

    // SUPABASE FIRST — it is authoritative for login (signInWithPassword).
    // Ordering rationale matches /api/auth/reset-password: Supabase-first means
    // a later RDS failure still leaves the user able to sign in, whereas
    // RDS-first would mean a Supabase failure locks them out entirely while the
    // mirror claims the new password works.
    //
    // admin.updateUserById, NOT supabase.auth.updateUser() as the legacy
    // /api/auth/change-password route uses: updateUser rotates the session
    // tokens, which can sign the user out mid-modal. The admin path leaves the
    // caller's session intact so they stay on the page they were on.
    const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
      claimed.user_id,
      { password },
    );

    if (supabaseError) {
      log.error("[CHANGE-PASSWORD-OTP] supabase update failed", {
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

    // RDS bcrypt mirror second, matched on users.id — never email. The claimed
    // row carries the id, so this path never re-derives the user from a typed
    // address and is structurally immune to the mixed-case bug documented in
    // /api/auth/change-password.
    const updated = await db
      .update(users)
      .set({
        password_hash: await hashPassword(password),
        must_change_password: false,
        updated_at: now,
      })
      .where(eq(users.id, claimed.user_id))
      .returning({ id: users.id });

    if (updated.length === 0) {
      // Still 200: the Supabase write succeeded, so the password genuinely did
      // change and reporting failure would be a lie.
      log.error("[CHANGE-PASSWORD-OTP] no users row — mirror not written", {
        userId: claimed.user_id,
        email: claimed.email,
      });
    }

    // Retire any other live sessions so a second code sitting in the user's
    // inbox can't be replayed.
    await db
      .update(passwordChangeOtps)
      .set({ consumed_at: now, updated_at: now })
      .where(
        and(
          eq(passwordChangeOtps.user_id, claimed.user_id),
          isNull(passwordChangeOtps.consumed_at),
        ),
      );

    log.info("[CHANGE-PASSWORD-OTP] password changed", {
      userId: claimed.user_id,
      email: claimed.email,
    });

    return NextResponse.json({
      ok: true,
      message: "Password updated successfully.",
    });
  } catch (err) {
    log.error("[CHANGE-PASSWORD-OTP] confirm unexpected error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "SERVER_ERROR", message: "Something went wrong." },
      { status: 500 },
    );
  }
}
