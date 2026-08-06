/**
 * The daily rollup: freeze yesterday, then prune.
 *
 * ops_metric_samples is the raw firehose and is pruned to 30 days.
 * ops_daily_snapshots is one frozen row per day per metric per source, and is
 * NEVER pruned — it is the trend history and the one-slide board's source. So
 * the order here matters: snapshot first, prune second, and never the reverse.
 *
 * RE-RUNNABLE BY DESIGN. The ticker holds "which IST day did I last roll up?"
 * in memory, so a restart makes it run again for the same date. The UNIQUE on
 * (snapshot_date, metric_key, source) from E-210 turns that into an upsert
 * rather than a duplicate, which is why the in-memory tracking is safe.
 *
 * IST THROUGHOUT. The boxes run UTC; the team, the standup and the 00:15
 * window are all Asia/Kolkata. A UTC "day" would put 05:30-onwards traffic in
 * the wrong bucket and make every daily comparison quietly wrong.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { log } from "@/lib/log";

/** Raw samples older than this go, having been rolled up first. */
export const SAMPLE_RETENTION_DAYS = 30;
/** Log lines older than this go. Matches the E-210 comment. */
export const LOG_RETENTION_DAYS = 14;

export interface DailySnapshotResult {
  snapshot_date: string;
  snapshots_written: number;
  samples_pruned: number;
  logs_pruned: number;
}

/** Today's date in IST as YYYY-MM-DD. */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** IST hour and minute, for the 00:15 window check. */
export function istHourMinute(d: Date = new Date()): {
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const [h, m] = parts.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** The IST day before the given instant, as YYYY-MM-DD. */
export function previousIstDate(now: Date = new Date()): string {
  return istDate(new Date(now.getTime() - 86_400_000));
}

/**
 * Roll one IST day of samples into ops_daily_snapshots, then prune.
 *
 * `value_num` is the day's LAST reading — the representative value, matching
 * how a gauge reads at end of day. min/max/avg describe the spread alongside
 * it, so a disk that spiked to 96% at 03:00 and settled back is not invisible
 * just because the final reading was calm.
 */
export async function runDailySnapshot(
  snapshotDate: string = previousIstDate(),
): Promise<DailySnapshotResult> {
  // DISTINCT ON gives the last sample per group; the aggregate CTE gives the
  // spread. Joined rather than done in two round trips so the frozen row is
  // internally consistent even if a collector writes mid-run.
  const snapshotRows = (await db.execute(sql`
    WITH day_samples AS (
      SELECT metric_key, source, value_num, captured_at
      FROM ops_metric_samples
      WHERE (captured_at AT TIME ZONE 'Asia/Kolkata')::date = ${snapshotDate}::date
        AND value_num IS NOT NULL
    ),
    aggregates AS (
      SELECT metric_key, source,
             MIN(value_num) AS value_min,
             MAX(value_num) AS value_max,
             AVG(value_num) AS value_avg,
             COUNT(*)::int  AS sample_count
      FROM day_samples
      GROUP BY metric_key, source
    ),
    last_value AS (
      SELECT DISTINCT ON (metric_key, source) metric_key, source, value_num
      FROM day_samples
      ORDER BY metric_key, source, captured_at DESC
    )
    INSERT INTO ops_daily_snapshots
      (snapshot_date, metric_key, source, value_num, value_min, value_max,
       value_avg, sample_count, updated_at)
    SELECT ${snapshotDate}::date, a.metric_key, a.source, l.value_num,
           a.value_min, a.value_max, a.value_avg, a.sample_count, NOW()
    FROM aggregates a
    JOIN last_value l ON l.metric_key = a.metric_key AND l.source = a.source
    ON CONFLICT (snapshot_date, metric_key, source) DO UPDATE SET
      value_num    = EXCLUDED.value_num,
      value_min    = EXCLUDED.value_min,
      value_max    = EXCLUDED.value_max,
      value_avg    = EXCLUDED.value_avg,
      sample_count = EXCLUDED.sample_count,
      updated_at   = NOW()
    RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;

  const snapshotsWritten = snapshotRows.length;

  // Prune only AFTER the rollup succeeded. If the INSERT above had thrown we
  // would never reach here, and a day's raw samples survive to be rolled up on
  // the next attempt rather than being deleted unrecorded.
  const prunedSamples = (await db.execute(sql`
    DELETE FROM ops_metric_samples
    WHERE captured_at < NOW() - MAKE_INTERVAL(days => ${SAMPLE_RETENTION_DAYS})
    RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;

  const prunedLogs = (await db.execute(sql`
    DELETE FROM ops_log_events
    WHERE logged_at < NOW() - MAKE_INTERVAL(days => ${LOG_RETENTION_DAYS})
    RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;

  const result: DailySnapshotResult = {
    snapshot_date: snapshotDate,
    snapshots_written: snapshotsWritten,
    samples_pruned: prunedSamples.length,
    logs_pruned: prunedLogs.length,
  };

  log.info(
    `[ops] daily rollup ${snapshotDate}: ${snapshotsWritten} snapshots, ` +
      `pruned ${result.samples_pruned} samples / ${result.logs_pruned} logs`,
  );

  return result;
}

/** Yesterday's frozen row per metric+source, for the one-slide board. */
export async function getSnapshotFor(
  snapshotDate: string,
): Promise<
  Map<string, { value_num: number | null; value_min: number | null; value_max: number | null }>
> {
  const rows = (await db.execute(sql`
    SELECT metric_key, source, value_num, value_min, value_max
    FROM ops_daily_snapshots
    WHERE snapshot_date = ${snapshotDate}::date
  `)) as unknown as Array<Record<string, unknown>>;

  const num = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return new Map(
    rows.map((r) => [
      `${r.metric_key as string}|${r.source as string}`,
      {
        value_num: num(r.value_num),
        value_min: num(r.value_min),
        value_max: num(r.value_max),
      },
    ]),
  );
}
