/**
 * The gate behind the admin "Notification Access" screen (E-231): which
 * dashboards have muted a given notification type in their in-app bell.
 *
 * SCOPE IS THE BELL ONLY. A muted recipient still gets the email — see the
 * split in emit.ts. `emailWorthy()` in catalog.ts remains the only switch on
 * that channel. This is deliberate: nobody should be able to silence an
 * agreement link or a password reset from a settings screen.
 *
 * WHY THIS SHAPE — `blockedDashboardsFor(type)`, not `isAllowed(role, type)`.
 * A per-recipient boolean can only ever be used from TypeScript, and three of
 * the four write paths are `INSERT … SELECT` statements that never materialise a
 * role in JS. Returning the blocked SET for one type instead means:
 *   - one lookup per EMIT rather than per recipient;
 *   - every recipient of one event sees a consistent answer, even if the cache
 *     would have expired midway through the fan-out;
 *   - it composes into SQL via `blockedSqlGuard()`.
 *
 * WHY IT LOADS ONLY THE DENIALS. Absence of a row means ENABLED (E-231), so the
 * cache only ever needs `WHERE enabled = false`. On a fresh install that is an
 * empty Map, `blockedSqlGuard()` renders `TRUE`, the TS filter is a no-op, and
 * every write path is byte-for-byte what it was before this module existed.
 * The `enabled = true` rows stay on disk purely as an audit trail of a mute that
 * was later lifted, and never reach the hot path.
 *
 * WHY IT FAILS OPEN. There is no migration runner in this project and
 * migrations have silently stopped applying on prod before. A missing table, a
 * dropped connection or a slow query must degrade to "everyone gets the
 * notification", never to "nobody does" — a notification that vanishes silently
 * is far more expensive than one that arrives when it could have been muted.
 * Every failure path here returns an empty denial set.
 */
import { eq, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { notificationAccess } from "@/lib/db/schema";

/** How long a loaded snapshot is reused. The save route invalidates explicitly. */
const TTL_MS = 60_000;

type Snapshot = {
  /** `${dashboard}|${type}` for every row with enabled = false. */
  denied: Set<string>;
  loadedAt: number;
};

let snapshot: Snapshot | null = null;
/** De-dupes a burst of concurrent emits after expiry into ONE query. */
let inFlight: Promise<Snapshot> | null = null;
/** So an unapplied migration logs once per TTL window, not once per emit. */
let lastErrorLoggedAt = 0;

async function load(): Promise<Snapshot> {
  try {
    const rows = await db
      .select({
        dashboard: notificationAccess.dashboard,
        notification_type: notificationAccess.notification_type,
      })
      .from(notificationAccess)
      .where(eq(notificationAccess.enabled, false));

    return {
      denied: new Set(rows.map((r) => `${r.dashboard.toLowerCase()}|${r.notification_type}`)),
      loadedAt: Date.now(),
    };
  } catch (error) {
    // Fail open, and cache the empty result for the full TTL so a missing table
    // does not produce one failed query per notification on a hot path.
    if (Date.now() - lastErrorLoggedAt > TTL_MS) {
      lastErrorLoggedAt = Date.now();
      console.error(
        "[notification-access] could not read notification_access — failing OPEN " +
          "(every notification will be delivered). Is E-231 applied on this database?",
        error,
      );
    }
    return { denied: new Set<string>(), loadedAt: Date.now() };
  }
}

async function current(): Promise<Snapshot> {
  const now = Date.now();
  if (snapshot && now - snapshot.loadedAt < TTL_MS) return snapshot;
  if (inFlight) return inFlight;

  inFlight = load()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * The dashboards (lowercased `users.role` values) that have muted `type`.
 * Empty — the overwhelmingly common case — means "nobody has muted this".
 */
export async function blockedDashboardsFor(type: string): Promise<string[]> {
  const { denied } = await current();
  if (denied.size === 0) return [];

  const suffix = `|${type}`;
  const blocked: string[] = [];
  for (const key of denied) {
    if (key.endsWith(suffix)) blocked.push(key.slice(0, -suffix.length));
  }
  return blocked;
}

/**
 * Narrow a list of role names to those still allowed to receive `type`.
 * Used by `notifyRoles`, which addresses roles directly rather than logins.
 */
export async function filterAllowedRoles(roles: string[], type: string): Promise<string[]> {
  const blocked = new Set(await blockedDashboardsFor(type));
  if (blocked.size === 0) return roles;
  return roles.filter((r) => !blocked.has(r.trim().toLowerCase()));
}

/**
 * An extra `AND …` for the `INSERT … SELECT` write paths, or nothing at all.
 *
 * Renders to an empty fragment when nobody has muted the type, so the generated
 * statement is unchanged from today in the common case.
 *
 * `roleColumn` is a raw SQL fragment naming the role column (e.g. `sql`u.role``).
 * It is lowercased HERE so no call site can forget: a case-sensitive comparison
 * would match nothing, so the gate would fail open while appearing to work —
 * this feature's worst failure mode, and an invisible one.
 */
export function blockedRoleClause(roleColumn: SQL, blocked: string[]): SQL {
  if (blocked.length === 0) return sql``;
  return sql`AND LOWER(${roleColumn}) NOT IN ${blocked}`;
}

/**
 * Drop the cached snapshot. Called by the save route so a toggle takes effect on
 * the very next notification rather than up to TTL_MS later.
 *
 * Production runs `instances: 1, exec_mode: "fork"` (ecosystem.prod.config.js),
 * so the route handler and every emitter share one heap and this is exact. The
 * TTL is the fallback for any topology where they do not.
 */
export function invalidateNotificationAccessCache(): void {
  snapshot = null;
  inFlight = null;
}

/** Test seam — lets a suite assert behaviour without waiting out the TTL. */
export const __testing = { reset: invalidateNotificationAccessCache };
