/**
 * The pure half of the log explorer: filter parsing and its bounds.
 *
 * Split out of logs.ts for the same reason usageMath.ts is split out of usage.ts
 * — @/lib/db throws at import time without DATABASE_URL, so anything importing
 * it cannot be unit tested. parseFilters() is the only thing standing between a
 * query string and four SQL statements, and it was previously untestable for
 * exactly this structural reason. Covered by __tests__/logsMath.test.ts.
 *
 * logs.ts re-exports everything here, so no caller needs to know about the
 * split.
 */

export type LogLevel = "error" | "warn" | "info";

export interface LogFilters {
  host?: string;
  service?: string;
  level?: LogLevel;
  /** Case-insensitive substring over `message`. */
  q?: string;
  /** Look-back window in whole hours. Clamped to MAX_HOURS. */
  hours: number;
  /** Restrict to one error group. */
  fingerprint?: string;
}

/** 14 days is the retention; asking for more just scans the whole table. */
export const MAX_HOURS = 24 * 14;
export const DEFAULT_HOURS = 24;
/** Raw lines rendered at once. Beyond this, narrow the filters. */
export const MAX_LINES = 300;
/**
 * Error groups returned by getLogsView().
 *
 * Exported because the page has to be able to SAY it is showing a top-N. It
 * previously rendered `groups.length` in a badge labelled "distinct", which read
 * as a total and silently pinned at 25 however many distinct errors there were.
 */
export const MAX_GROUPS = 25;
export const MAX_SEARCH_CHARS = 200;

/** sha256 hex, which is what fingerprint() produces and the column stores. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

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
  const fingerprint = one("fingerprint");

  return {
    host: one("host")?.slice(0, 32),
    service: one("service")?.slice(0, 120),
    level:
      level === "error" || level === "warn" || level === "info"
        ? level
        : undefined,
    q: one("q")?.slice(0, MAX_SEARCH_CHARS),
    hours: parseHours(one("hours")),
    // Anything that is not a full sha256 hex cannot match a stored row, so it is
    // rejected here rather than run as a guaranteed-empty query.
    fingerprint:
      fingerprint && FINGERPRINT_RE.test(fingerprint) ? fingerprint : undefined,
  };
}

/**
 * The look-back window, as a WHOLE number of hours.
 *
 * THE INTEGER PART IS NOT COSMETIC. This value reaches
 * `MAKE_INTERVAL(hours => $1)`, whose parameter Postgres infers as `integer`
 * from the function signature — so `?hours=0.5` was sent as the text `0.5`,
 * rejected with "invalid input syntax for type integer", and surfaced as the
 * whole Logs page replaced by an error card with a raw SQL dump in it. A
 * fractional window is also meaningless against hourly buckets.
 *
 * Truncated rather than rounded, so a value is never widened into scanning more
 * than was asked for, and floored at 1 so `?hours=0.5` reads as the narrowest
 * real window instead of silently jumping to the 24-hour default.
 */
export function parseHours(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_HOURS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_HOURS;
  return Math.max(1, Math.min(Math.trunc(value), MAX_HOURS));
}
