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
 * Record one credential entry.
 *
 * The caller passes an id already proven by requireAuth() against the session
 * cookie — never a value from a request body, so one account cannot manufacture
 * a login for another.
 *
 * The WHERE NOT EXISTS is a dedupe guard, not an optimisation: a double-clicked
 * submit, a retried fetch or a React strict-mode double-invoke would otherwise
 * each add a row and inflate the count. Two minutes is comfortably longer than
 * any of those and far shorter than a real second login. Served by
 * user_login_events_user_occurred_idx.
 */
export async function recordLoginEvent(user: {
  id: string;
  role?: string | null;
}): Promise<void> {
  if (!shouldTrack(user.role)) return;

  try {
    await db.execute(sql`
      INSERT INTO user_login_events (user_id, role_at_login, method)
      SELECT ${user.id}::uuid, ${user.role ?? null}, 'password'
      WHERE NOT EXISTS (
        SELECT 1 FROM user_login_events
        WHERE user_id = ${user.id}::uuid
          AND occurred_at > NOW() - INTERVAL '2 minutes'
      )
    `);
  } catch (e) {
    // Deliberately swallowed. If the table is missing (E-214 unapplied) this is
    // the ONLY signal, so it is logged rather than silently dropped.
    console.error("[usage] recordLoginEvent failed:", e);
  }
}
