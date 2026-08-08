/**
 * CRM usage tracking — the write half.
 *
 * Everything here is FIRE-AND-FORGET AND NEVER THROWS. That is the single most
 * important property in this file: a person must never fail to log in, or see an
 * error, because usage analytics had a bad day. Every function catches its own
 * failures and returns quietly; the cost of a lost row is a slightly wrong chart,
 * and the cost of a thrown error is somebody locked out of the CRM.
 *
 * SCOPE. These are the only per-person records in the codebase, so what they do
 * NOT capture matters as much as what they do:
 *
 *   recorded     — that a credential was entered, when, and the role at the time.
 *   NOT recorded — IP, user-agent, page paths, search terms, failed attempts.
 *
 * Retention is 90 days (logins) / 30 days (sessions), enforced by
 * runDailySnapshot(). Only aggregates survive beyond that, and no per-person row
 * is ever written to ops_metric_samples. See drizzle/E-214_usage_analytics.sql
 * for the full reasoning, and lib/operations/route-guard.ts for who may read it.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/**
 * How often the browser heartbeat fires, in seconds. Duration maths depends on
 * it (engaged = ping_count * HEARTBEAT_SECONDS), so it lives here rather than
 * being repeated in the client and the collector.
 */
export const HEARTBEAT_SECONDS = 300;

/**
 * Roles NOT tracked: external counterparties, not staff.
 *
 * Dealers, scrap vendors and NBFC partners reach (dashboard)/layout.tsx too, so
 * without this they would be measured by default. They sit under different terms
 * from employees, and session-timing a business partner is a customer-analytics
 * product with a different consent basis — not the licence-and-capacity question
 * this feature exists to answer.
 *
 * The counter-argument is real and worth recording: dealer-portal adoption IS a
 * legitimate ops question, and excluding at WRITE time is irreversible in a way
 * that filtering at read time would not be. Shipping the narrower version first
 * is the defensible order; widening later is a one-line change to this set.
 */
export const EXTERNAL_ROLES = new Set([
  "dealer",
  "scrap_vendor",
  "nbfc_partner",
]);

/**
 * Kill switch. `USAGE_TRACKING=0` stops every write without a deploy — the thing
 * you want to exist before you start recording people, not after.
 */
export function usageTrackingEnabled(): boolean {
  return process.env.USAGE_TRACKING !== "0";
}

/** Both switches in one place, so the two write routes cannot disagree. */
export function shouldTrack(role: string | null | undefined): boolean {
  if (!usageTrackingEnabled()) return false;
  return !EXTERNAL_ROLES.has((role ?? "").trim().toLowerCase());
}

/**
 * Record a credential entry, keyed on Supabase's OWN sign-in timestamp.
 *
 * WHY THIS IS DRIVEN BY A TIMESTAMP RATHER THAN BY A CLIENT CALL.
 *
 * The first design fired a fire-and-forget fetch from the login page after
 * signInWithPassword resolved. It is a browser's prerogative to drop a
 * keepalive request when the page navigates away a moment later, and when that
 * happens it fails SILENTLY — no error, no row, and nothing anywhere to
 * distinguish "the write was lost" from "nobody logged in". That ambiguity cost
 * a long debugging session and would have recurred forever in production.
 *
 * So this is now called from /api/user/profile, which the login flow already
 * awaits and which cannot be lost to navigation. The catch is that route runs
 * on EVERY AuthProvider mount, so "was called" says nothing about whether a
 * login happened.
 *
 * `auth.users.last_sign_in_at` is what makes it work. Supabase updates it on
 * every password grant and NOT on a token refresh, so it is an authoritative,
 * idempotent marker for "a credential was entered at time T". Insert only when
 * T is newer than the newest row already stored for that user:
 *
 *   · a page navigation reuses the same T -> no row
 *   · a token refresh does not move T     -> no row
 *   · a real new sign-in moves T          -> exactly one row
 *   · two tabs racing both compare against the same T; the unique-ish check
 *     plus the equality guard means at most one wins
 *
 * That also removes the old two-minute dedupe window, which was a heuristic
 * standing in for exactly this signal — and it stores occurred_at = T, so a row
 * here can never disagree with Supabase about when somebody signed in.
 *
 * Never throws. A login must not fail, or look like it failed, because
 * analytics did.
 */
export async function recordLoginEvent(user: {
  id: string;
  role?: string | null;
  /** authUser.last_sign_in_at from requireAuthWithSupabaseUser(). */
  lastSignInAt?: string | null;
}): Promise<void> {
  if (!shouldTrack(user.role)) return;
  // No timestamp means no way to tell a login from a navigation. Record
  // nothing rather than one row per page view.
  if (!user.lastSignInAt) return;

  const at = new Date(user.lastSignInAt);
  if (Number.isNaN(at.getTime())) return;

  try {
    await db.execute(sql`
      INSERT INTO user_login_events (user_id, role_at_login, method, occurred_at)
      SELECT ${user.id}::uuid, ${user.role ?? null}, 'password', ${at.toISOString()}::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM user_login_events
        WHERE user_id = ${user.id}::uuid
          AND occurred_at >= ${at.toISOString()}::timestamptz
      )
    `);
  } catch (e) {
    // Deliberately swallowed. If the table is missing (E-214 unapplied) this is
    // the ONLY signal, so it is logged rather than silently dropped.
    console.error("[usage] recordLoginEvent failed:", e);
  }
}
