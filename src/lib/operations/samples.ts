/**
 * Reading ops_metric_samples.
 *
 * Every Ops Console page reads through here. Pages never call a vendor, never
 * shell out and never touch a collector — they read this table, which is what
 * lets the dashboard still render (stale, with a timestamp) when the thing it
 * monitors is down.
 *
 * `value_num` is Postgres `numeric`, which the driver returns as a STRING to
 * avoid float precision loss. Everything here converts on the way out, so no
 * page ever has to remember that.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { toNumber } from "./format";

export interface LatestSample {
  metric_key: string;
  source: string;
  value_num: number | null;
  value_text: string | null;
  meta: Record<string, unknown> | null;
  captured_at: Date;
  /** Minutes since this sample was captured — the staleness of the number. */
  age_minutes: number;
}

/**
 * The newest sample for every (metric_key, source) pair among `metricKeys`.
 *
 * DISTINCT ON is Postgres's cheap "latest row per group" and matches the
 * (metric_key, captured_at DESC) index from E-210 exactly.
 *
 * `maxAgeHours` bounds the scan. It does NOT hide stale numbers — a sample from
 * six hours ago still comes back, carrying its age, because "this number is old"
 * is the single most useful thing a monitoring page can tell you. It exists so
 * the query cannot degrade into a full-table scan as history accumulates.
 */
export async function latestSamples(
  metricKeys: string[],
  opts: { maxAgeHours?: number } = {},
): Promise<LatestSample[]> {
  if (metricKeys.length === 0) return [];
  const maxAgeHours = opts.maxAgeHours ?? 24;

  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (metric_key, source)
      metric_key, source, value_num, value_text, meta, captured_at
    FROM ops_metric_samples
    WHERE metric_key IN ${metricKeys}
      -- MAKE_INTERVAL rather than multiplying INTERVAL '1 hour' by a bind
      -- parameter: the driver sends parameters untyped, which leaves Postgres
      -- resolving an "unknown * interval" operator. The named argument pins
      -- the parameter to integer instead.
      AND captured_at > NOW() - MAKE_INTERVAL(hours => ${maxAgeHours})
    ORDER BY metric_key, source, captured_at DESC
  `)) as unknown as Array<Record<string, unknown>>;

  const now = Date.now();
  return rows.map((r) => {
    const capturedAt = new Date(r.captured_at as string);
    return {
      metric_key: r.metric_key as string,
      source: r.source as string,
      value_num: toNumber(r.value_num),
      value_text: (r.value_text as string) ?? null,
      meta: (r.meta as Record<string, unknown>) ?? null,
      captured_at: capturedAt,
      age_minutes: (now - capturedAt.getTime()) / 60_000,
    };
  });
}

/**
 * The most recent sample of one metric for ONE source — the "previous reading"
 * a rate calculation needs.
 *
 * Called from a collector BEFORE it writes this cycle's sample, so the newest
 * row in the table is still the previous cycle's. That is the whole contract:
 * a cumulative counter (blks_hit, xact_commit, deadlocks…) only means something
 * as the difference between two readings, and the earlier reading has to come
 * from somewhere that survives a process restart. ops_metric_samples is that
 * somewhere — an in-memory previous value would reset on every deploy and
 * silently produce a first-interval spike.
 *
 * Returns null when there is no predecessor inside `maxAgeMinutes`. Callers
 * must OMIT the derived metric in that case rather than emitting zero: a zero
 * renders as a real measurement and hides the gap.
 *
 * The age window matters. Two samples an hour apart still divide correctly, but
 * a "reads per second" averaged over an hour of which 58 minutes were downtime
 * describes nothing, so the caller passes a bound close to its own interval.
 */
export async function previousSample(
  metricKey: string,
  source: string,
  maxAgeMinutes: number,
): Promise<LatestSample | null> {
  const rows = (await db.execute(sql`
    SELECT metric_key, source, value_num, value_text, meta, captured_at
    FROM ops_metric_samples
    WHERE metric_key = ${metricKey}
      AND source = ${source}
      AND captured_at > NOW() - MAKE_INTERVAL(mins => ${maxAgeMinutes})
    ORDER BY captured_at DESC
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const r = rows[0];
  if (!r) return null;

  const capturedAt = new Date(r.captured_at as string);
  return {
    metric_key: r.metric_key as string,
    source: r.source as string,
    value_num: toNumber(r.value_num),
    value_text: (r.value_text as string) ?? null,
    meta: (r.meta as Record<string, unknown>) ?? null,
    captured_at: capturedAt,
    age_minutes: (Date.now() - capturedAt.getTime()) / 60_000,
  };
}

/** Index a LatestSample[] as `${metric_key}|${source}` for O(1) tile lookups. */
export function bySourceKey(
  samples: LatestSample[],
): Map<string, LatestSample> {
  return new Map(samples.map((s) => [`${s.metric_key}|${s.source}`, s]));
}

/** All sources seen for one metric, sorted — e.g. every host, every pm2 process. */
export function sourcesFor(
  samples: LatestSample[],
  metricKey: string,
): string[] {
  return [
    ...new Set(
      samples.filter((s) => s.metric_key === metricKey).map((s) => s.source),
    ),
  ].sort();
}

export interface SeriesPoint {
  at: Date;
  value: number | null;
}

export type SeriesMap = Map<string, SeriesPoint[]>;

/**
 * Bucketed history for a set of metrics, keyed `${metric_key}|${source}`.
 *
 * Downsampled in SQL rather than in JS: at one sample every 5 minutes, 24 hours
 * of nine host metrics across three boxes is ~7,800 rows to ship and throw away.
 * 15-minute buckets give ~96 points per series, which is more than a sparkline
 * a few hundred pixels wide can resolve anyway.
 *
 * AVG per bucket, not last-in-bucket — a disk that spiked and recovered inside
 * one bucket should still bend the line rather than vanish.
 */
export async function seriesFor(
  metricKeys: string[],
  opts: { hours?: number; bucketMinutes?: number } = {},
): Promise<SeriesMap> {
  const out: SeriesMap = new Map();
  if (metricKeys.length === 0) return out;

  const hours = opts.hours ?? 24;
  const bucketSeconds = (opts.bucketMinutes ?? 15) * 60;

  const rows = (await db.execute(sql`
    SELECT
      metric_key,
      source,
      TO_TIMESTAMP(
        FLOOR(EXTRACT(EPOCH FROM captured_at) / ${bucketSeconds}) * ${bucketSeconds}
      ) AS bucket,
      AVG(value_num) AS value
    FROM ops_metric_samples
    WHERE metric_key IN ${metricKeys}
      AND captured_at > NOW() - MAKE_INTERVAL(hours => ${hours})
      AND value_num IS NOT NULL
    GROUP BY metric_key, source, bucket
    ORDER BY metric_key, source, bucket
  `)) as unknown as Array<Record<string, unknown>>;

  for (const r of rows) {
    const key = `${r.metric_key as string}|${r.source as string}`;
    const list = out.get(key) ?? [];
    list.push({
      at: new Date(r.bucket as string),
      value: toNumber(r.value),
    });
    out.set(key, list);
  }

  return out;
}
