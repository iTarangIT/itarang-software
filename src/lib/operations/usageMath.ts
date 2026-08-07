/**
 * The pure half of the usage read model: filter parsing and duration maths.
 *
 * Split out of usage.ts for the same reason elevenlabsSeries.ts is split out of
 * elevenlabs.ts — @/lib/db throws at import time when DATABASE_URL is unset, so
 * anything importing it cannot be unit tested. Everything here is a pure
 * function over plain data and is covered by __tests__/usageMath.test.ts.
 */

/** Windows the login history offers. Anything else is rejected, not clamped. */
export const USAGE_DAY_WINDOWS = [1, 7, 30, 90] as const;
export const DEFAULT_USAGE_DAYS = 7;

/**
 * Hard cap on rows returned to the page. The login history is a per-person view;
 * an unbounded one invites bulk export, which is a different product from
 * "answer an operational question".
 */
export const MAX_USAGE_ROWS = 300;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface UsageFilters {
  /** One of USAGE_DAY_WINDOWS. */
  days: number;
  /** Narrow the history to one person. Undefined = everyone. */
  user?: string;
  /** True when the view shows per-person rows, which is what gets audited. */
  perPerson: boolean;
}

/**
 * Validate the URL params. SHAPE ONLY — mirrors parseFilters() in logs.ts, and
 * lives here rather than in the page so the page and the JSON API cannot
 * disagree about what a filter means.
 *
 * `days` is matched against an allow-list rather than clamped: a clamp turns
 * `?days=999999` into a silent 90, while an allow-list makes it the default and
 * keeps the URL honest about what is on screen.
 */
export function parseUsageFilters(
  params: Record<string, string | string[] | undefined>,
): UsageFilters {
  const one = (key: string): string | undefined => {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value : undefined;
  };

  const rawDays = Number(one("days"));
  const days = (USAGE_DAY_WINDOWS as readonly number[]).includes(rawDays)
    ? rawDays
    : DEFAULT_USAGE_DAYS;

  // A non-UUID is dropped rather than passed through — it can only be a typo or
  // an injection attempt, and either way there is no user it could match.
  const userRaw = one("user");
  const user = isUuid(userRaw) ? userRaw : undefined;

  return { days, user, perPerson: true };
}

/**
 * How long somebody was actually IN the CRM during one session, in seconds.
 *
 * Ping-derived, not span-derived, and that is the whole point: a laptop that
 * slept for three hours with a tab open sends 2 heartbeats, so it reports
 * 2 x 300s rather than 3 hours. Reporting the span would make "time spent in the
 * CRM" a measure of how long a browser tab existed, which is not the question.
 *
 * The `+ heartbeatSeconds` gives a single-ping session credit for one interval
 * instead of zero. The LEAST() caps at the wall-clock span so a client with a
 * skewed clock, or one pinging in a tight loop, cannot inflate its own total.
 */
export function engagedSeconds(
  pingCount: number,
  spanSeconds: number,
  heartbeatSeconds = 300,
): number {
  const pings = Number.isFinite(pingCount) ? Math.max(0, pingCount) : 0;
  const span = Number.isFinite(spanSeconds) ? Math.max(0, spanSeconds) : 0;
  return Math.min(pings * heartbeatSeconds, span + heartbeatSeconds);
}

/**
 * Linear-interpolated percentile over an unsorted numeric array.
 *
 * Returns NULL for an empty input, never 0. An empty window must render "—";
 * a zero would read as "sessions are instantaneous", which is a confident claim
 * about data we do not have.
 */
export function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0]!;

  const rank = (clean.length - 1) * Math.min(Math.max(p, 0), 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return clean[lower]!;
  return clean[lower]! + (clean[upper]! - clean[lower]!) * (rank - lower);
}
