/**
 * The read model behind /operations/logs.
 *
 * Shared by the page, the JSON route and the Excel export so all three agree on
 * what a filter means — an export that quietly returns a different set from the
 * table it was launched from is worse than no export.
 *
 * Everything is bounded. This table is the one place in the console where the
 * row count is driven by how badly things are going, and a query with no ceiling
 * is a page that stops loading exactly when it is needed.
 */

import { and, eq, gt, ilike, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { opsLogEvents } from "@/lib/db/schema";

import { MAX_GROUPS, MAX_LINES, type LogFilters } from "./logsMath";

// Re-exported so every existing import of "@/lib/operations/logs" keeps working
// — the pure half moved out to become testable, not to move callers around.
export {
  DEFAULT_HOURS,
  MAX_GROUPS,
  MAX_HOURS,
  MAX_LINES,
  MAX_SEARCH_CHARS,
  parseFilters,
  parseHours,
  type LogFilters,
  type LogLevel,
} from "./logsMath";

function whereFor(filters: LogFilters): SQL | undefined {
  const clauses: SQL[] = [
    gt(
      opsLogEvents.logged_at,
      sql`NOW() - MAKE_INTERVAL(hours => ${filters.hours})`,
    ),
  ];

  if (filters.host) clauses.push(eq(opsLogEvents.host, filters.host));
  if (filters.service) clauses.push(eq(opsLogEvents.service, filters.service));
  if (filters.level) clauses.push(eq(opsLogEvents.level, filters.level));
  if (filters.fingerprint) {
    clauses.push(eq(opsLogEvents.fingerprint, filters.fingerprint));
  }
  if (filters.q) {
    // ilike with a leading wildcard cannot use an index, which is why `hours`
    // is clamped and the row cap below is not negotiable.
    clauses.push(ilike(opsLogEvents.message, `%${filters.q}%`));
  }

  return and(...clauses);
}

export interface LogLine {
  id: string;
  host: string;
  service: string;
  level: string;
  message: string;
  logged_at: Date;
  fingerprint: string;
}

export interface ErrorGroup {
  fingerprint: string;
  service: string;
  level: string;
  count: number;
  hosts: string[];
  first_at: Date;
  last_at: Date;
  /** The most recent message in the group — the sample shown in the table. */
  sample: string;
}

export interface RatePoint {
  at: Date;
  errors: number;
  warns: number;
}

export interface LogsView {
  filters: LogFilters;
  lines: LogLine[];
  /** True when the cap truncated the result — the UI must say so. */
  truncated: boolean;
  groups: ErrorGroup[];
  /**
   * How many distinct fingerprints match, IGNORING the MAX_GROUPS cap.
   *
   * Separate from `groups.length` because they answer different questions and
   * were previously conflated: the page rendered `groups.length` in a badge
   * labelled "distinct", which pinned at 25 forever and so read as "there are 25
   * distinct errors" during an incident with hundreds.
   */
  distinct_groups: number;
  /** True when `groups` is a top-N slice rather than the whole set. */
  groups_truncated: boolean;
  rate: RatePoint[];
  totals: { errors: number; warns: number; infos: number };
  facets: { hosts: string[]; services: string[] };
}

export async function getLogsView(filters: LogFilters): Promise<LogsView> {
  const where = whereFor(filters);

  const [lineRows, groupRows, rateRows, totalRows, facetRows] = await Promise.all([
    // Raw lines, newest first. One over the cap so we can tell "exactly 300"
    // from "at least 300" without a second COUNT.
    db
      .select({
        id: opsLogEvents.id,
        host: opsLogEvents.host,
        service: opsLogEvents.service,
        level: opsLogEvents.level,
        message: opsLogEvents.message,
        logged_at: opsLogEvents.logged_at,
        fingerprint: opsLogEvents.fingerprint,
      })
      .from(opsLogEvents)
      .where(where)
      .orderBy(sql`${opsLogEvents.logged_at} DESC`)
      .limit(MAX_LINES + 1),

    // Grouped by fingerprint. `(ARRAY_AGG(x ORDER BY logged_at DESC))[1]` picks
    // the newest value per group — so the sample shown is a real line as it was
    // logged, not the normalised form the fingerprint was computed from.
    // (Not DISTINCT ON, which an earlier version of this comment claimed: that
    // cannot coexist with the GROUP BY aggregates this needs.)
    db.execute(sql`
      SELECT
        fingerprint,
        COUNT(*)::int                    AS count,
        MIN(logged_at)                   AS first_at,
        MAX(logged_at)                   AS last_at,
        ARRAY_AGG(DISTINCT host)         AS hosts,
        (ARRAY_AGG(service ORDER BY logged_at DESC))[1] AS service,
        (ARRAY_AGG(level   ORDER BY logged_at DESC))[1] AS level,
        (ARRAY_AGG(message ORDER BY logged_at DESC))[1] AS sample
      FROM ops_log_events
      WHERE ${where}
      GROUP BY fingerprint
      ORDER BY count DESC, last_at DESC
      LIMIT ${MAX_GROUPS}
    `),

    // Hourly error/warn counts for the chart. Buckets, not raw rows: a busy hour
    // is thousands of rows and the chart needs one number per hour.
    //
    // GAP-FILLED, via generate_series LEFT JOINed to the counts. The previous
    // version emitted only hours that HAD rows, which defeated the chart's whole
    // stated purpose — LogRateChart's comment argues that "an hour with no errors
    // is a real, meaningful zero" and it draws a baseline tick for one, but it
    // never received those rows. Bars are positioned by array index, so three
    // scattered hours in a 14-day window rendered as three bars spread evenly
    // across the axis, reading as continuous activity.
    //
    // BUCKETED IN IST, like every other day/hour boundary in the console. On a
    // UTC session (which is what the pooled connection gives us) truncating the
    // raw timestamptz put boundaries at :30 in IST, so every bar was labelled
    // 05:30, 06:30 and so on. The join happens in naive IST space and the result
    // is converted back to timestamptz, so what reaches JS is still an instant
    // and formatIst() cannot double-shift it.
    db.execute(sql`
      WITH bounds AS (
        SELECT
          DATE_TRUNC('hour', (NOW() AT TIME ZONE 'Asia/Kolkata')
                             - MAKE_INTERVAL(hours => ${filters.hours})) AS from_h,
          DATE_TRUNC('hour', (NOW() AT TIME ZONE 'Asia/Kolkata'))        AS to_h
      ),
      buckets AS (
        SELECT generate_series(from_h, to_h, INTERVAL '1 hour') AS bucket
        FROM bounds
      ),
      counted AS (
        SELECT
          DATE_TRUNC('hour', logged_at AT TIME ZONE 'Asia/Kolkata') AS bucket,
          COUNT(*) FILTER (WHERE level = 'error')::int AS errors,
          COUNT(*) FILTER (WHERE level = 'warn')::int  AS warns
        FROM ops_log_events
        WHERE ${where}
        GROUP BY 1
      )
      SELECT
        (b.bucket AT TIME ZONE 'Asia/Kolkata') AS bucket,
        COALESCE(c.errors, 0)::int             AS errors,
        COALESCE(c.warns, 0)::int              AS warns
      FROM buckets b
      LEFT JOIN counted c ON c.bucket = b.bucket
      ORDER BY b.bucket
    `),

    // COUNT(DISTINCT fingerprint) rides along on the totals query rather than
    // costing a fifth round trip — same window, same predicate, one more
    // aggregate over rows already being scanned.
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE level = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE level = 'warn')::int  AS warns,
        COUNT(*) FILTER (WHERE level = 'info')::int  AS infos,
        COUNT(DISTINCT fingerprint)::int             AS distinct_groups
      FROM ops_log_events
      WHERE ${where}
    `),

    // Facets come from the WINDOW, not the current filters — otherwise picking
    // host=prod would remove every other host from the dropdown that changed it.
    db.execute(sql`
      SELECT DISTINCT host, service
      FROM ops_log_events
      WHERE logged_at > NOW() - MAKE_INTERVAL(hours => ${filters.hours})
      LIMIT 500
    `),
  ]);

  const groups = (groupRows as unknown as Array<Record<string, unknown>>).map(
    (r): ErrorGroup => ({
      fingerprint: String(r.fingerprint),
      service: String(r.service ?? ""),
      level: String(r.level ?? ""),
      count: Number(r.count ?? 0),
      hosts: Array.isArray(r.hosts) ? (r.hosts as string[]) : [],
      first_at: new Date(r.first_at as string),
      last_at: new Date(r.last_at as string),
      sample: String(r.sample ?? ""),
    }),
  );

  const rate = (rateRows as unknown as Array<Record<string, unknown>>).map(
    (r): RatePoint => ({
      at: new Date(r.bucket as string),
      errors: Number(r.errors ?? 0),
      warns: Number(r.warns ?? 0),
    }),
  );

  const totalRow = (totalRows as unknown as Array<Record<string, unknown>>)[0];
  const facets = facetRows as unknown as Array<Record<string, unknown>>;

  const distinctGroups = Number(totalRow?.distinct_groups ?? 0);

  return {
    filters,
    lines: lineRows.slice(0, MAX_LINES) as LogLine[],
    truncated: lineRows.length > MAX_LINES,
    groups,
    distinct_groups: distinctGroups,
    groups_truncated: distinctGroups > groups.length,
    rate,
    totals: {
      errors: Number(totalRow?.errors ?? 0),
      warns: Number(totalRow?.warns ?? 0),
      infos: Number(totalRow?.infos ?? 0),
    },
    facets: {
      hosts: [...new Set(facets.map((r) => String(r.host)))].sort(),
      services: [...new Set(facets.map((r) => String(r.service)))].sort(),
    },
  };
}

/**
 * Rows for the Excel export.
 *
 * Same filters, no group/rate/facet work, and a higher ceiling — a spreadsheet
 * is where you go precisely because the on-screen 300 was not enough.
 */
export async function getLogLinesForExport(
  filters: LogFilters,
  limit = 10_000,
): Promise<LogLine[]> {
  const rows = await db
    .select({
      id: opsLogEvents.id,
      host: opsLogEvents.host,
      service: opsLogEvents.service,
      level: opsLogEvents.level,
      message: opsLogEvents.message,
      logged_at: opsLogEvents.logged_at,
      fingerprint: opsLogEvents.fingerprint,
    })
    .from(opsLogEvents)
    .where(whereFor(filters))
    .orderBy(sql`${opsLogEvents.logged_at} DESC`)
    .limit(limit);

  return rows as LogLine[];
}
