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
/**
 * v2 because the stored shape gained `uid` — the id of the signed-in user the
 * session belongs to. See the versioning note above: this is a rename, not a
 * migration, and a stale v1 value is simply never read again.
 *
 * WHY THE SHAPE CHANGED. localStorage is per-ORIGIN, so a session id minted for
 * one account survived a logout and was reused by the next person to sign in on
 * that browser. Two things then went wrong at once: the module rows recorded
 * against that id could no longer be traced to the account that produced them,
 * and recordHeartbeat's `WHERE user_id = EXCLUDED.user_id` guard silently
 * dropped the second user's session entirely — no update, and no INSERT either,
 * because the conflict had already fired. Storing the owner alongside the id is
 * what lets currentSession() notice and mint a fresh one.
 */
export const LS_SESSION = "itarang.usage.sid.v2";
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

/**
 * The modules /operations/usage reports on (E-215).
 *
 * A CLOSED ALLOW-LIST, and that is the entire privacy argument for per-module
 * tracking. The browser resolves its own location against this list and sends
 * the LABEL; the path itself never leaves the tab. See the E-215 header.
 *
 * Values are the first path segment, which is also what is stored — so
 * `module_usage_daily.module` reads the same as the URL people talk about in
 * standups, and no lookup table is needed to interpret the data.
 *
 * Adding one is a one-line change here plus a row in the page's label map.
 * Until then a new module accumulates under `other`, visibly, which is the
 * intended failure mode: a rising 'other' count is a prompt, not a silent loss.
 */
export const MODULES = [
  "nbfc",
  "inside-sales",
  "dealer-portal",
  "ceo",
  "sales-head",
  "asm",
] as const;

export type ModuleName = (typeof MODULES)[number] | "other";

/** Everything not in MODULES. A real value, not a null — see above. */
export const MODULE_OTHER = "other" as const;

const MODULE_SET: ReadonlySet<string> = new Set(MODULES);

/**
 * Reduce a pathname to a module label.
 *
 * Matches on the FIRST SEGMENT ONLY, compared for equality rather than by
 * prefix. `startsWith("/sales-head")` would quietly fold a future
 * `/sales-headcount` into `sales-head` and nobody would ever notice the numbers
 * were wrong; segment equality cannot.
 *
 * Everything else — including `/operations` itself, `/profile`, and the
 * dashboard root — is `other`. The console deliberately does not track itself:
 * the people reading the page would otherwise be its most active users.
 *
 * Pure, total, and never throws on a malformed input: this runs inside the
 * heartbeat's ping path, where an exception would silently kill the timer for
 * the rest of the tab's life.
 */
export function moduleFromPath(pathname: string | null | undefined): ModuleName {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return MODULE_OTHER;
  }

  // Strip any query or hash a caller passed in by mistake, then take segment 1.
  // Split on "/" and skip the empty string before the leading slash.
  const first = pathname.split(/[?#]/, 1)[0]!.split("/")[1] ?? "";
  const segment = first.trim().toLowerCase();

  return MODULE_SET.has(segment) ? (segment as ModuleName) : MODULE_OTHER;
}

/**
 * Coerce a module label that arrived over the wire onto the allow-list.
 *
 * The client already maps its own path through moduleFromPath(), so in normal
 * operation this is a formality — but it sits on a WRITE PATH TAKING A STRING
 * FROM A BROWSER, and the one thing that must never happen is an arbitrary
 * string reaching the `module` column. That column deliberately has no CHECK
 * constraint (an unknown label must land as 'other' and stay visible rather than
 * fail somebody's heartbeat), which puts the entire burden here.
 *
 * Anything unrecognised becomes 'other': a stale client after a rename, a
 * hand-crafted POST, or a caller that skipped moduleFromPath and sent a full
 * path. That last case is why this does NOT fall back to moduleFromPath() — a
 * path arriving here is a bug to be starved of data, not a format to support.
 *
 * Lives beside moduleFromPath rather than in track.ts so it can be unit tested;
 * track.ts imports @/lib/db and therefore cannot be. Same split, same reason, as
 * usageMath.ts vs usage.ts.
 */
export function normaliseModule(value: unknown): ModuleName {
  if (typeof value !== "string") return MODULE_OTHER;
  const clean = value.trim().toLowerCase();
  return MODULE_SET.has(clean) ? (clean as ModuleName) : MODULE_OTHER;
}
