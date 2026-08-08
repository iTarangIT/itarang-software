/**
 * The read model behind /operations/usage.
 *
 * One question: is the CRM actually being used, by whom, and how much?
 *
 * WHY THIS IS NOT PART OF /operations/team. That page measures licence and
 * capacity from Supabase's auth.users.last_sign_in_at — sign-in RECENCY, which
 * counts somebody whose refresh token is alive but who has not opened the CRM in
 * a fortnight. This one reads our own E-214 tables and measures observed usage.
 * The two numbers differ on purpose; each page says which it is showing.
 *
 * SCOPE, because this is the only per-person read surface in the codebase:
 * aggregates come from ops_metric_samples (written by the usage.activity
 * collector), and the per-person rows are queried LIVE here and never persisted
 * as a time series. What survives forever is aggregate; what names a person
 * expires in 30-90 days. See §8 of docs/OPERATIONS_RUNBOOK.md.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { getMetric, type MetricDef } from "./registry";
import { bySourceKey, latestSamples, seriesFor, type SeriesPoint } from "./samples";
import { MAX_USAGE_ROWS, type UsageFilters } from "./usageMath";
import { USAGE_SAMPLE_KEYS } from "./usageSamples";
import { ENGAGED_SECONDS_SQL } from "./usageSql";

export type { UsageFilters } from "./usageMath";

/** Matches SOURCE in collectors/usage.ts. Aggregate-only, by construction. */
const SOURCE = "usage:all";

/**
 * Every metric the usage collector emits, in tile order. Kept in step with
 * USAGE_SAMPLE_KEYS in usageSamples.ts — that module is the one the
 * aggregate-only test pins, this one is just the render order.
 *
 * The session-derived tiles read "—" until USAGE_HEARTBEAT is switched on,
 * which is correct: no data is not zero, and severityFor() renders an absent
 * value as "unknown" rather than green.
 */
const USAGE_METRICS = [...USAGE_SAMPLE_KEYS];

export interface UsageMetricRow {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  help?: string;
  value: number | null;
  age_minutes: number | null;
  series: SeriesPoint[];
}

export interface LoginEventRow {
  id: string;
  user_id: string;
  name: string;
  role: string;
  method: string;
  occurred_at: Date;
}

export interface LoginDayPoint {
  /** YYYY-MM-DD in IST. */
  day: string;
  logins: number;
  people: number;
}

export interface SessionTotals {
  /** Sessions started in the window. */
  count: number;
  /** Distinct people behind them. */
  people: number;
  /** Sum of engaged time, in minutes. Ping-derived, never wall-clock. */
  minutes: number;
  /** Sessions still pinging (last 11 minutes). */
  active_now: number;
}

export interface UsageView {
  filters: UsageFilters;
  metrics: UsageMetricRow[];
  /**
   * Live session figures over the selected window, computed here rather than
   * read from samples so they follow the filter. Zeroed until the heartbeat is
   * enabled — the table is empty, which is a true reading of "no sessions".
   */
  sessions: SessionTotals;
  /** Logins per day over the selected window, gaps included as explicit zeros. */
  login_trend: LoginDayPoint[];
  /** Distinct people who entered a credential in the window. */
  people_in_window: number;
  logins_in_window: number;
  history: LoginEventRow[];
  /** True when the history was cut off by MAX_USAGE_ROWS. */
  history_truncated: boolean;
  /** No sample has ever been written — the collector has not run yet. */
  never_collected: boolean;
}

export async function getUsageView(
  filters: UsageFilters,
): Promise<UsageView> {
  const days = filters.days;
  const userFilter = filters.user
    ? sql` AND e.user_id = ${filters.user}::uuid`
    : sql``;

  const sessionUserFilter = filters.user
    ? sql` AND s.user_id = ${filters.user}::uuid`
    : sql``;

  const [samples, series, trendRows, totalsRows, historyRows, sessionRows] =
    await Promise.all([
      // 48 hours, matching the other module views: the collector runs every 15
      // minutes, so a 24h window would still show a number after a long outage
      // but a shorter one would blank out after a couple of missed cycles.
      latestSamples(USAGE_METRICS, { maxAgeHours: 48 }),
      seriesFor(USAGE_METRICS, { hours: 24 * 7, bucketMinutes: 60 }),

      // Bucketed in IST so a day boundary here means the same thing as it does
      // everywhere else in the console.
      db.execute(sql`
        SELECT
          TO_CHAR(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
          COUNT(*)::int                        AS logins,
          COUNT(DISTINCT e.user_id)::int       AS people
        FROM user_login_events e
        WHERE e.occurred_at > NOW() - (${days} || ' days')::interval
          ${userFilter}
        GROUP BY 1
        ORDER BY 1
      `),

      db.execute(sql`
        SELECT
          COUNT(*)::int                  AS logins,
          COUNT(DISTINCT e.user_id)::int AS people
        FROM user_login_events e
        WHERE e.occurred_at > NOW() - (${days} || ' days')::interval
          ${userFilter}
      `),

      // LEFT JOIN so a departed employee's logins still appear rather than
      // vanishing from history — the same convention team.ts uses, and the
      // reason user_login_events carries no FK.
      //
      // Capped at MAX_USAGE_ROWS + 1 so the page can say "truncated" instead of
      // quietly showing a prefix as if it were everything.
      db.execute(sql`
        SELECT
          e.id::text            AS id,
          e.user_id::text       AS user_id,
          COALESCE(u.name, 'unknown')  AS name,
          COALESCE(e.role_at_login, u.role, 'unknown') AS role,
          e.method              AS method,
          e.occurred_at         AS occurred_at
        FROM user_login_events e
        LEFT JOIN users u ON u.id = e.user_id
        WHERE e.occurred_at > NOW() - (${days} || ' days')::interval
          ${userFilter}
        ORDER BY e.occurred_at DESC
        LIMIT ${MAX_USAGE_ROWS + 1}
      `),

      // Session totals over the SAME window as everything else, so the tiles and
      // the tables below cannot describe different periods. Duration uses the
      // shared ENGAGED_SECONDS_SQL, which is the SQL twin of engagedSeconds() —
      // defined once so the collector's p50/p90 and this figure cannot drift.
      db.execute(sql`
        SELECT
          COUNT(*)::int                  AS count,
          COUNT(DISTINCT s.user_id)::int AS people,
          COALESCE(SUM(${ENGAGED_SECONDS_SQL}), 0) / 60 AS minutes,
          COUNT(*) FILTER (
            WHERE s.last_seen_at > NOW() - INTERVAL '11 minutes'
          )::int                         AS active_now
        FROM user_activity_sessions s
        WHERE s.started_at > NOW() - (${days} || ' days')::interval
          ${sessionUserFilter}
      `),
    ]);

  const index = bySourceKey(samples);

  const metrics = USAGE_METRICS.map((key): UsageMetricRow | null => {
    const def = getMetric(key);
    if (!def) return null;
    const sample = index.get(`${key}|${SOURCE}`);
    return {
      key,
      label: def.label,
      unit: def.unit,
      help: def.help,
      value: sample?.value_num ?? null,
      age_minutes: sample?.age_minutes ?? null,
      series: series.get(`${key}|${SOURCE}`) ?? [],
    };
  }).filter((m): m is UsageMetricRow => m !== null);

  const rows = historyRows as unknown as Array<Record<string, unknown>>;
  const truncated = rows.length > MAX_USAGE_ROWS;

  const history: LoginEventRow[] = rows
    .slice(0, MAX_USAGE_ROWS)
    .map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      name: String(r.name),
      role: String(r.role),
      method: String(r.method),
      occurred_at: new Date(r.occurred_at as string),
    }));

  const found = new Map<string, { logins: number; people: number }>();
  for (const r of trendRows as unknown as Array<Record<string, unknown>>) {
    found.set(String(r.day), {
      logins: Number(r.logins ?? 0),
      people: Number(r.people ?? 0),
    });
  }

  const totals = (totalsRows as unknown as Array<Record<string, unknown>>)[0];

  const sess = (sessionRows as unknown as Array<Record<string, unknown>>)[0];

  return {
    filters,
    metrics,
    sessions: {
      count: Number(sess?.count ?? 0),
      people: Number(sess?.people ?? 0),
      minutes: Math.round(Number(sess?.minutes ?? 0)),
      active_now: Number(sess?.active_now ?? 0),
    },
    login_trend: fillLoginDays(found, days),
    people_in_window: Number(totals?.people ?? 0),
    logins_in_window: Number(totals?.logins ?? 0),
    history,
    history_truncated: truncated,
    never_collected: metrics.every((m) => m.value == null),
  };
}

/**
 * A day with no logins is a real reading — "nobody signed in" — so it has to be
 * an explicit zero rather than a closed gap in the chart. Same contract as
 * fillDays() in elevenlabsSeries.ts, kept local because it carries a different
 * point shape.
 */
function fillLoginDays(
  found: Map<string, { logins: number; people: number }>,
  days: number,
  today: Date = new Date(),
): LoginDayPoint[] {
  const out: LoginDayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(today.getTime() - i * 86_400_000));
    const hit = found.get(day);
    out.push({
      day,
      logins: hit?.logins ?? 0,
      people: hit?.people ?? 0,
    });
  }
  return out;
}
