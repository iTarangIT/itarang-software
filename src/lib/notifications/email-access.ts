/**
 * The gate behind the admin "Email Notification" tab (E-284): which notification
 * types have had their EMAIL channel overridden by an admin.
 *
 * The sibling of src/lib/notifications/access.ts, which does the same job for
 * the in-app bell — same 60s snapshot, same single-flight load, same fail-open
 * discipline. Read that file first; only the differences are explained here.
 *
 * WHY AN ABSENT ROW MEANS SOMETHING DIFFERENT HERE.
 * In E-231, no row meant ENABLED, because the code had no opinion about who
 * should see a bell row. Here the code DOES have an opinion — emailWorthy() in
 * catalog.ts — and each of its 15 NO_EMAIL entries carries a reason worth
 * keeping. So an absent row means "fall through to the code", and the map
 * therefore has to load BOTH true and false rows; there is no "denials only"
 * shortcut to take.
 *
 * WHY IT FAILS OPEN TO AN EMPTY MAP, NOT TO "SEND EVERYTHING".
 * Empty map => every type resolves through emailWorthy() => byte-for-byte the
 * behaviour this app had before E-284 existed. That is a stronger guarantee
 * than "everyone gets the email": it also preserves the NO_EMAIL suppressions,
 * so a missing table cannot start emailing auction.outbid several times a
 * second. There is no migration runner in this project and migrations have
 * silently stopped applying on prod before (MIGRATION_CHECKLIST.md, ~E-145), so
 * this path is a real operating mode, not a theoretical one.
 *
 * WHY THE RESOLVER LIVES HERE AND NOT IN catalog.ts.
 * catalog.ts is in the CLIENT bundle — the settings screen imports its
 * taxonomy. It must stay free of `db`. emailEnabledFor() is the server-side
 * composition of the two.
 */
import { db } from "@/lib/db";
import { notificationEmailAccess } from "@/lib/db/schema";
import { resolveEmailChannel } from "@/lib/notifications/catalog";

/** How long a loaded snapshot is reused. The save route invalidates explicitly. */
const TTL_MS = 60_000;

type Snapshot = {
  /** notification_type -> enabled. ONLY types an admin has decided about. */
  overrides: Map<string, boolean>;
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
        notification_type: notificationEmailAccess.notification_type,
        enabled: notificationEmailAccess.enabled,
      })
      .from(notificationEmailAccess);

    return {
      overrides: new Map(rows.map((r) => [r.notification_type, r.enabled])),
      loadedAt: Date.now(),
    };
  } catch (error) {
    // Fail open to the CODE DEFAULT, and cache the empty result for the full TTL
    // so a missing table does not produce one failed query per notification.
    if (Date.now() - lastErrorLoggedAt > TTL_MS) {
      lastErrorLoggedAt = Date.now();
      console.error(
        "[notification-email] could not read notification_email_access — falling " +
          "back to emailWorthy() for every type (i.e. pre-E-284 behaviour). " +
          "Is E-284 applied on this database?",
        error,
      );
    }
    return { overrides: new Map<string, boolean>(), loadedAt: Date.now() };
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
 * The admin's saved answer for `type`, or `undefined` when nobody has decided —
 * which is the overwhelmingly common case and means "use the code default".
 */
export async function emailOverrideFor(type: string): Promise<boolean | undefined> {
  const { overrides } = await current();
  return overrides.get(type);
}

/** Every saved override, for the settings screen's GET. */
export async function allEmailOverrides(): Promise<Record<string, boolean>> {
  const { overrides } = await current();
  return Object.fromEntries(overrides);
}

/**
 * Whether `type` should be emailed with no per-recipient flag in play — i.e. the
 * answer the settings screen shows. The precedence rule itself lives in
 * catalog.ts so emit(), which DOES have a recipient flag, cannot diverge from it.
 */
export async function emailEnabledFor(type: string): Promise<boolean> {
  return resolveEmailChannel(type, await emailOverrideFor(type), undefined);
}

/**
 * Drop the cached snapshot. Called by the save route so a toggle takes effect on
 * the very next notification rather than up to TTL_MS later.
 *
 * Production runs `instances: 1, exec_mode: "fork"` (ecosystem.prod.config.js),
 * so the route handler and every emitter share one heap and this is exact. The
 * TTL is the fallback for any topology where they do not.
 */
export function invalidateEmailAccessCache(): void {
  snapshot = null;
  inFlight = null;
}

/** Test seam — lets a suite assert behaviour without waiting out the TTL. */
export const __testing = {
  reset: invalidateEmailAccessCache,
  /** Install a snapshot directly, so precedence can be tested without a DB. */
  seed(overrides: Record<string, boolean>): void {
    snapshot = { overrides: new Map(Object.entries(overrides)), loadedAt: Date.now() };
    inFlight = null;
  },
};
