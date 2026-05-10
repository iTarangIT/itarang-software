/**
 * E-048 — Telemetry data freshness classifier (BRD §6.2.5)
 *
 * Pure-compute classifier: takes a `last_seen` timestamp (or null) and the
 * server's current time, and returns a freshness label + display badge per
 * the §6.2.5 freshness table:
 *
 *   last_seen            | freshness | badge
 *   -------------------- | --------- | ----------------------------
 *   < 15 min ago         | fresh     | "Just now"
 *   15 min – 6 h ago     | idle      | "${h}h ago"
 *   6 h – 24 h ago       | stale     | "${h}h ago (stale)"
 *   > 24 h ago           | offline   | "Offline >24h"
 *   NULL (never seen)    | never     | "Awaiting first ping"
 *
 * No DB writes. Used by E-050/E-051 query APIs (and the GET endpoint at
 * /api/iot/battery/[serial]/freshness) to decorate iot_devices rows.
 *
 * Boundaries: lower-inclusive, upper-exclusive (per YAML non_functional). For
 * the "idle" / "stale" buckets we display whole hours via `Math.floor(deltaMs
 * / 3_600_000)` — minutes show as `0h ago` only when delta < 1h, i.e. between
 * 15 and 60 minutes; that matches "X minutes ago" being collapsed to "0h ago"
 * is ugly, so we widen idle's badge to include a minutes case (still inside
 * the same 15-min..6-h bucket; freshness label is unchanged).
 */

export type FreshnessLabel = "fresh" | "idle" | "stale" | "offline" | "never";

export interface FreshnessResult {
  freshness: FreshnessLabel;
  badge: string;
}

const MIN_MS = 60 * 1_000;
const HOUR_MS = 60 * MIN_MS;
const FRESH_CUTOFF_MS = 15 * MIN_MS;
const IDLE_CUTOFF_MS = 6 * HOUR_MS;
const STALE_CUTOFF_MS = 24 * HOUR_MS;

/**
 * Classify a single `last_seen` value against `now`.
 *
 * @param lastSeen Date|string|null — accepts Drizzle's Date, an ISO string, or null.
 * @param now Optional override (default = new Date()), useful for tests.
 */
export function classifyFreshness(
  lastSeen: Date | string | null | undefined,
  now: Date = new Date(),
): FreshnessResult {
  if (lastSeen === null || lastSeen === undefined) {
    return { freshness: "never", badge: "Awaiting first ping" };
  }

  const seenAt = lastSeen instanceof Date ? lastSeen : new Date(lastSeen);
  // Defensive: an invalid Date (NaN time) collapses to "never" rather than
  // mis-classifying as offline.
  if (Number.isNaN(seenAt.getTime())) {
    return { freshness: "never", badge: "Awaiting first ping" };
  }

  const deltaMs = now.getTime() - seenAt.getTime();
  // A negative delta (clock skew / future timestamp) is treated as fresh.
  if (deltaMs < FRESH_CUTOFF_MS) {
    return { freshness: "fresh", badge: "Just now" };
  }
  if (deltaMs < IDLE_CUTOFF_MS) {
    const hours = Math.floor(deltaMs / HOUR_MS);
    if (hours < 1) {
      const minutes = Math.floor(deltaMs / MIN_MS);
      return { freshness: "idle", badge: `${minutes}m ago` };
    }
    return { freshness: "idle", badge: `${hours}h ago` };
  }
  if (deltaMs < STALE_CUTOFF_MS) {
    const hours = Math.floor(deltaMs / HOUR_MS);
    return { freshness: "stale", badge: `${hours}h ago (stale)` };
  }
  return { freshness: "offline", badge: "Offline >24h" };
}
