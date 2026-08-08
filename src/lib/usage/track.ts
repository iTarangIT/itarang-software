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
 * Re-exported from ./constants so this module's import surface is unchanged.
 * It cannot be DEFINED here: this file imports @/lib/db, so a client component
 * importing the constant from here would drag a Postgres client into the
 * browser bundle.
 */
export { HEARTBEAT_SECONDS } from "./constants";

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

/** Is this an external counterparty rather than staff? */
export function isExternalRole(role: string | null | undefined): boolean {
  return EXTERNAL_ROLES.has((role ?? "").trim().toLowerCase());
}

/**
 * The heartbeat's own switch, on top of the global one.
 *
 * Three properties, each deliberate:
 *
 *   1. DEFAULTS OFF, tested with `=== "1"` — the inverse of usageTrackingEnabled's
 *      `!== "0"`. The asymmetry is the point: login tracking is already live, so
 *      turning it OFF is the emergency action; the heartbeat is new and measures
 *      people continuously, so it must never start recording merely because a
 *      deploy shipped. It is switched on deliberately, after the staff notice.
 *   2. NESTED, not parallel. USAGE_TRACKING=0 kills this too, or the runbook's
 *      "one switch stops everything" promise becomes false the day this ships.
 *   3. Named for the mechanism, not the metric — it gates session AND (from
 *      E-215) module tracking, so USAGE_SESSIONS would have been too narrow.
 */
export function usageHeartbeatEnabled(): boolean {
  return usageTrackingEnabled() && process.env.USAGE_HEARTBEAT === "1";
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

/**
 * Record one heartbeat against a session.
 *
 * The caller passes a user id already proven by requireAuth() against the
 * session cookie, and a role read from the same place — never from the request
 * body, or a client could assert its way out of the external classification.
 *
 * Two clauses in the upsert are controls rather than optimisations:
 *
 *   WHERE user_id = EXCLUDED.user_id
 *     SECURITY. If B posts A's session_id the conflict fires, this predicate is
 *     false, and nothing happens — A's ping_count and last_seen_at are
 *     untouched, and because it is ON CONFLICT the INSERT does not run either,
 *     so B cannot claim the row. The cost is explicit: B's own session then goes
 *     unrecorded for as long as they keep sending A's id. That is the correct
 *     direction to fail. A missing session understates usage; the alternative
 *     overstates somebody ELSE's working day, which is the one error a page
 *     that measures people must never make.
 *
 *   AND last_seen_at < NOW() - INTERVAL '240 seconds'
 *     INFLATION. 240s is 80% of the 300s cadence, so ordinary timer drift always
 *     passes while a client looping at 1Hz gets exactly one increment per four
 *     minutes. Read-time engagedSeconds() caps at wall clock as well, so
 *     inflation is defended at both ends.
 *
 * Never throws.
 */
export async function recordHeartbeat(params: {
  userId: string;
  role: string | null | undefined;
  sessionId: string;
}): Promise<void> {
  if (!usageHeartbeatEnabled()) return;
  // Externals get NO session row at all — that guarantee is enforced by this
  // early return rather than by a filter somebody could later relax. Their
  // module usage is recorded in aggregate by E-215; see the migration header.
  if (isExternalRole(params.role)) return;

  try {
    await db.execute(sql`
      INSERT INTO user_activity_sessions (user_id, session_id, role_at_start)
      VALUES (${params.userId}::uuid, ${params.sessionId}::uuid, ${params.role ?? null})
      ON CONFLICT (session_id) DO UPDATE SET
        last_seen_at = NOW(),
        ping_count   = user_activity_sessions.ping_count + 1
      WHERE user_activity_sessions.user_id = EXCLUDED.user_id
        AND user_activity_sessions.last_seen_at < NOW() - INTERVAL '240 seconds'
    `);
  } catch (e) {
    console.error("[usage] recordHeartbeat failed:", e);
  }
}
