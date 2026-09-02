/**
 * The pure half of the CRM-usage collector: turning query results into samples.
 *
 * WHY THIS FILE EXISTS AT ALL. The privacy guarantee this whole feature rests on
 * is that the collector writes AGGREGATES ONLY — no per-person row ever reaches
 * ops_metric_samples or ops_daily_snapshots, which are never pruned. Both the
 * migration header and §8 of the Ops Runbook state that a test enforces it.
 *
 * No such test existed. It could not exist: collectors/usage.ts imports
 * @/lib/db, which throws at import time without DATABASE_URL, so vitest could
 * never load it. The guarantee was asserted in prose and unenforced in code.
 *
 * Splitting the decision-making out here — the collector queries, this file
 * shapes — makes the invariant testable without a database. Same split, and the
 * same reason, as elevenlabsSeries.ts vs elevenlabs.ts and usageMath.ts vs
 * usage.ts.
 */

import type { CollectedSample } from "./collectors/types";

/**
 * The ONLY source this collector may ever emit under.
 *
 * A per-person leak would show up here first — as "usage:<uuid>" or similar —
 * which is exactly what the test asserts against.
 */
export const USAGE_SOURCE = "usage:all";

/** Every metric key the usage collector produces, in emit order. */
export const USAGE_SAMPLE_KEYS = [
  "usage.logins_24h",
  "usage.dau",
  "usage.wau",
  "usage.mau",
  "usage.sessions_24h",
  "usage.active_sessions",
  "usage.session_minutes_p50",
  "usage.session_minutes_p90",
] as const;

export type UsageSampleKey = (typeof USAGE_SAMPLE_KEYS)[number];

/**
 * One query's outcome. `null` means the query failed or returned nothing —
 * distinct from 0, which means it succeeded and the answer was zero.
 */
export type UsageInput = Partial<Record<UsageSampleKey, number | null>>;

/**
 * Shape query results into samples.
 *
 * Two rules, both load-bearing:
 *
 *   1. A null/absent/non-finite input emits NO SAMPLE, never a zero. A confident
 *      zero on a broken query is a lie in the one direction that looks healthy —
 *      the tile would render green while the pipeline was dead. Omitting it
 *      leaves the tile stale, which severityFor() reports as "unknown" and never
 *      as OK.
 *   2. Every sample carries USAGE_SOURCE. There is no code path that can attach
 *      a per-person source, because the caller does not get to choose one.
 */
export function buildUsageSamples(input: UsageInput): CollectedSample[] {
  const samples: CollectedSample[] = [];

  for (const key of USAGE_SAMPLE_KEYS) {
    const value = input[key];
    if (value == null || !Number.isFinite(value)) continue;
    samples.push({
      metric_key: key,
      source: USAGE_SOURCE,
      value_num: value,
    });
  }

  return samples;
}

/**
 * Unwrap a `Promise.allSettled` entry into a single numeric column.
 *
 * Returns null on rejection, on an empty result set, or on a non-numeric value,
 * so the caller cannot accidentally turn a failure into a zero.
 */
export function numFrom(
  result: PromiseSettledResult<Array<Record<string, unknown>>>,
  column: string,
): number | null {
  if (result.status !== "fulfilled") return null;
  const raw = result.value?.[0]?.[column];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
