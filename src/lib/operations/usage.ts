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
import { usageHeartbeatEnabled } from "@/lib/usage/track";

import {
  getModuleDetail,
  getModuleUsage,
  getModuleUsers,
  type ModuleDetailView,
  type ModuleUsageView,
  type ModuleUsersView,
} from "./moduleUsage";
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
  /**
   * Whether the server is actually recording sessions and module usage right
   * now, i.e. usageHeartbeatEnabled().
   *
   * Surfaced because the page previously INFERRED it from `sessions.count === 0`
   * and printed "session tracking not enabled yet" — which is a claim about
   * configuration derived from an absence of data. It happened to be right while
   * the flag was off, and would have been confidently wrong the moment the flag
   * was switched on with nobody yet measured. A page whose job is diagnosis has
   * to distinguish "switched off" from "on, but nothing recorded".
   */
  heartbeat_enabled: boolean;
  /** Logins per day over the selected window, gaps included as explicit zeros. */
  login_trend: LoginDayPoint[];
  /**
   * Per-module roll-up over the same window (E-215). Aggregate only — it has no
   * user filter because module_usage_daily has no user_id, so unlike everything
   * else on this page it does not narrow when `?user=` is set. The page labels it
   * as company-wide so that is not read as a bug.
   */
  modules: ModuleUsageView;
  /**
   * The selected module's day-by-day breakdown, or null when none is selected.
   *
   * Null rather than an empty detail so the page can tell "nothing chosen" from
   * "chosen, and nobody used it" — the same distinction `never_seen` draws in
   * the summary table, and for the same reason.
   */
  module_detail: ModuleDetailView | null;
  /**
   * Who used the selected module (E-216), or null when none is selected.
   *
   * The ONLY per-person module data on this page. Its presence is what makes the
   * drill-down an audited surface — see recordUsageView in the page and the API
   * route. Null and empty mean different things: null is "no module chosen",
   * empty is "chosen, and E-216 has recorded nobody on it yet".
   */
  module_users: ModuleUsersView | null;
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

  const [
    samples,
    series,
    trendRows,
    totalsRows,
    historyRows,
    sessionRows,
    modules,
    moduleDetail,
    moduleUsers,
  ] = await Promise.all([
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

      // Takes no user filter — see the `modules` field on UsageView. It also
      // never rejects, so an unapplied E-215 cannot turn this whole page into an
      // error card; it reports `unavailable` and the page says so.
      getModuleUsage(days),

      // Only when a module is actually selected — the default page must not pay
      // for a drill-down nobody opened. Resolves to null otherwise, which is the
      // "nothing chosen" state the page distinguishes from an empty result.
      filters.module
        ? getModuleDetail(filters.module, days)
        : Promise.resolve(null),

      // Same condition, deliberately a separate query rather than a join: the
      // aggregate detail must still render if E-216 is missing, and joining
      // them would let one absent table blank the other.
      filters.module
        ? getModuleUsers(filters.module, days)
        : Promise.resolve(null),
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
    // Read here rather than in the page so the JSON API reports the same thing.
    heartbeat_enabled: usageHeartbeatEnabled(),
    login_trend: fillLoginDays(found, days),
    modules,
    module_detail: moduleDetail,
    module_users: moduleUsers,
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
