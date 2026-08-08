/**
 * CRM usage constants, deliberately free of any database import.
 *
 * These are needed by three consumers that cannot all reach the same module:
 * the browser heartbeat (a client component), the SQL duration expression, and
 * the server write path. `track.ts` imports @/lib/db, which throws at import
 * time without DATABASE_URL and would drag a Postgres client into the browser
 * bundle — so the shared numbers live here and `track.ts` re-exports what it
 * needs. Same split, same reason, as usageMath.ts vs usage.ts.
 */

/**
 * How often the browser heartbeat fires.
 *
 * Session duration is derived as `ping_count * HEARTBEAT_SECONDS`, so this
 * number is not a tuning knob you can change casually — it is the unit of
 * account for every duration figure in the console, and changing it re-scales
 * historical data that was collected at the old cadence. If load ever demands
 * it, 600 is the next sensible value and the SQL expression reads this constant
 * too, so both halves move together.
 */
export const HEARTBEAT_SECONDS = 300;
export const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;

/**
 * No activity for this long ends the session; the next activity starts a new
 * one. Fifteen minutes is the usual convention and, more to the point, it is
 * what the staff notice says — so it cannot be changed without changing that.
 *
 * The effect worth understanding: a 45-minute lunch produces two sessions of
 * real work rather than one session that bills the sandwich.
 */
export const IDLE_MS = 15 * 60 * 1000;

/**
 * A session cannot outlive this, whatever the tab does.
 *
 * Without it, a machine left logged in over a long weekend produces one
 * "session" of 70 hours, which single-handedly destroys p90 and makes the whole
 * duration column untrustworthy.
 */
export const MAX_SESSION_MS = 16 * 60 * 60 * 1000;

/**
 * How long a tab may hold the leader lease before another may claim it. Only
 * used on browsers without the Web Locks API.
 */
export const LEASE_TTL_MS = 45 * 1000;

/**
 * Random delay before the first ping, so N people arriving at 09:00 do not stay
 * phase-locked and hit the route in the same second for the rest of the day.
 */
export const JITTER_MS = 30 * 1000;

/**
 * When the server says tracking is off, wait this long before asking again.
 * Long enough that "off" costs one request per tab per six hours; short enough
 * that flipping the switch on is picked up without asking anyone to reload.
 */
export const OFF_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * localStorage keys. Versioned, so a future format change is a rename rather
 * than a migration — a stale value under a v1 key is simply never read again.
 *
 * localStorage and NOT sessionStorage: sessionStorage is per-tab, so one person
 * with three tabs would be counted as three concurrent sessions.
 */
export const LS_SESSION = "itarang.usage.sid.v1";
export const LS_LAST_ACTIVE = "itarang.usage.last.v1";
export const LS_LEADER = "itarang.usage.leader.v1";
export const LS_OFF_UNTIL = "itarang.usage.off.v1";

/**
 * Client-side build gate. Compiled into the bundle, so when it is off the
 * component returns null before mounting any effect — no timers, no listeners,
 * no network traffic whatsoever.
 *
 * Distinct from the SERVER flag (USAGE_HEARTBEAT in track.ts), which decides
 * whether anything is written. Recommended launch posture is this one ON and
 * the server one OFF: the code is live and exercised, nothing is recorded, and
 * flipping the switch later is an env change rather than a rebuild.
 */
export function heartbeatClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USAGE_HEARTBEAT === "1";
}
