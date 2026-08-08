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

/**
 * Per-person usage retention (E-214). These are not tuning knobs: both numbers
 * are promised in the migration header, in §8 of the Ops Runbook, and in the
 * notice shown to staff on /operations/usage. Changing either without changing
 * those three is breaking a commitment made to the people being measured.
 *
 * usage.mau also sits exactly on the 30-day session edge. If that window is
 * ever shortened, MAU silently becomes a shorter measure rather than failing —
 * which is why the metric's help text says so.
 */
export const SESSION_RETENTION_DAYS = 30;
export const LOGIN_RETENTION_DAYS = 90;

export interface DailySnapshotResult {
  snapshot_date: string;
  snapshots_written: number;
  samples_pruned: number;
  logs_pruned: number;
  sessions_pruned: number;
  login_events_pruned: number;
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

  // The E-214 prunes are INDIVIDUALLY GUARDED, unlike the two above.
  //
  // Those are unguarded safely, because E-210 is applied on every environment.
  // E-214 is not — and an undefined_table thrown here would abort the whole
  // function BEFORE ops_metric_samples was pruned, turning a schema gap on one
  // environment into unbounded disk growth on it. That failure would be silent
  // and slow, which is the worst combination. Each prune now fails alone.
  const sessionsPruned = await pruneQuietly(
    "user_activity_sessions",
    sql`
      DELETE FROM user_activity_sessions
      WHERE last_seen_at < NOW() - MAKE_INTERVAL(days => ${SESSION_RETENTION_DAYS})
      RETURNING id
    `,
  );

  const loginEventsPruned = await pruneQuietly(
    "user_login_events",
    sql`
      DELETE FROM user_login_events
      WHERE occurred_at < NOW() - MAKE_INTERVAL(days => ${LOGIN_RETENTION_DAYS})
      RETURNING id
    `,
  );

  const result: DailySnapshotResult = {
    snapshot_date: snapshotDate,
    snapshots_written: snapshotsWritten,
    samples_pruned: prunedSamples.length,
    logs_pruned: prunedLogs.length,
    sessions_pruned: sessionsPruned,
    login_events_pruned: loginEventsPruned,
  };

  log.info(
    `[ops] daily rollup ${snapshotDate}: ${snapshotsWritten} snapshots, ` +
      `pruned ${result.samples_pruned} samples / ${result.logs_pruned} logs / ` +
      `${result.sessions_pruned} sessions / ${result.login_events_pruned} logins`,
  );

  return result;
}

/**
 * Run one DELETE, returning how many rows went, and swallow a missing table.
 *
 * Retention is a promise to the people in these tables, so a prune that fails
 * must be loud in the logs — but it must not take the rest of the rollup with
 * it. Anything other than a missing relation is re-thrown, because a genuine
 * failure to delete expired personal data should not be hidden.
 */
async function pruneQuietly(
  table: string,
  statement: ReturnType<typeof sql>,
): Promise<number> {
  try {
    const rows = (await db.execute(statement)) as unknown as Array<
      Record<string, unknown>
    >;
    return rows.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/does not exist/i.test(message)) {
      log.warn(`[ops] skipped ${table} prune — table not present (E-214?)`);
      return 0;
    }
    throw e;
  }
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
