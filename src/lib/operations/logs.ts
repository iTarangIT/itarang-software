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

export type LogLevel = "error" | "warn" | "info";

export interface LogFilters {
  host?: string;
  service?: string;
  level?: LogLevel;
  /** Case-insensitive substring over `message`. */
  q?: string;
  /** Look-back window. Clamped to MAX_HOURS. */
  hours: number;
  /** Restrict to one error group. */
  fingerprint?: string;
}

/** 14 days is the retention; asking for more just scans the whole table. */
export const MAX_HOURS = 24 * 14;
export const DEFAULT_HOURS = 24;
/** Raw lines rendered at once. Beyond this, narrow the filters. */
export const MAX_LINES = 300;
const MAX_GROUPS = 25;
const MAX_SEARCH_CHARS = 200;

/**
 * Normalise whatever arrived in the query string.
 *
 * Everything here is user input reaching SQL. Values are bound as parameters
 * (Drizzle never interpolates), but clamping still matters: an unbounded `hours`
 * turns a filtered read into a full scan of a table that grows with every
 * incident.
 */
export function parseFilters(
  params: Record<string, string | string[] | undefined>,
): LogFilters {
  const one = (key: string): string | undefined => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };

  const level = one("level")?.toLowerCase();
  const hours = Number(one("hours") ?? DEFAULT_HOURS);

  return {
    host: one("host")?.slice(0, 32),
    service: one("service")?.slice(0, 120),
    level:
      level === "error" || level === "warn" || level === "info"
        ? level
        : undefined,
    q: one("q")?.slice(0, MAX_SEARCH_CHARS),
    hours:
      Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_HOURS) : DEFAULT_HOURS,
    // sha256 hex — anything else cannot match a stored row, so reject it here
    // rather than run a guaranteed-empty query.
    fingerprint: /^[0-9a-f]{64}$/.test(one("fingerprint") ?? "")
      ? one("fingerprint")
      : undefined,
  };
}

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

    // Grouped by fingerprint. DISTINCT ON picks the newest message per group as
    // the sample, so the table shows a real line rather than a normalised one.
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

    // Hourly error/warn counts for the sparkline. Buckets, not raw rows: a busy
    // hour is thousands of rows and the chart needs 24 numbers.
    db.execute(sql`
      SELECT
        DATE_TRUNC('hour', logged_at) AS bucket,
        COUNT(*) FILTER (WHERE level = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE level = 'warn')::int  AS warns
      FROM ops_log_events
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE level = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE level = 'warn')::int  AS warns,
        COUNT(*) FILTER (WHERE level = 'info')::int  AS infos
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

  return {
    filters,
    lines: lineRows.slice(0, MAX_LINES) as LogLine[],
    truncated: lineRows.length > MAX_LINES,
    groups,
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
