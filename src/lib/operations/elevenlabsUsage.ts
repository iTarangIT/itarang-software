/**
 * HISTORICAL credit consumption from ElevenLabs.
 *
 * WHY THIS EXISTS. The only vendor endpoint this codebase called was
 * `/v1/user/subscription`, which reports the CURRENT billing period: credits
 * remaining, the quota, and consumption so far. That is a live balance and
 * nothing else — there is no "credits consumed in May" in it. The two places
 * that might have stood in for history cannot:
 *
 *   · ops_metric_samples is pruned at 30 days (daily.ts SAMPLE_RETENTION_DAYS).
 *   · ops_daily_snapshots is never pruned, but the ops module is days old, so
 *     it holds a week — not the six months the filter offers.
 *
 * So selecting "Last 6 months" showed six months of OUR rupee cost beside a
 * credit balance that was current as of a minute ago. The two halves of the
 * page answered different questions about time.
 *
 * `/v1/usage/character-stats` is the vendor's own historical series and closes
 * that gap exactly. Verified against the live account: monthly `metric=credits`
 * for Jan–Aug 2026 returns [0, 0, 0, 0, 159, 233995, 10533, 247], and the
 * August figure (247) reconciles to the digit with `character_count` from
 * /v1/user/subscription. Same account, same meaning, one live and one
 * historical.
 *
 * NOTHING HERE IS STORED. The vendor keeps the full history and returns any
 * window on request, so caching it into our own tables would only create a
 * second copy to drift. A short in-process cache spares the API a call per page
 * render; that is all.
 *
 * The pure half (window → unix bounds, response → keyed points) is exported for
 * unit testing — this module deliberately imports no database client.
 */

import type { ElevenLabsFilters } from "./elevenlabsSeries";

const BASE_URL = "https://api.elevenlabs.io";

/**
 * How long a fetched window is reused.
 *
 * The page auto-refreshes every 60s and the vendor aggregates by day at best,
 * so a fresh call per render would be pure waste. Ten minutes is far below the
 * granularity of anything this data can express.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Below the page's own patience, so a hung vendor degrades rather than hangs. */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Floor for the "all time" window.
 *
 * The account cannot have usage before it existed, and the vendor returns
 * zero-filled buckets for the empty stretch, so this only needs to be early
 * enough — 2023-01-01 predates the ElevenLabs integration by years.
 */
const ALL_TIME_FLOOR_MS = Date.UTC(2023, 0, 1);

export interface CreditUsagePoint {
  /** YYYY-MM-DD or YYYY-MM, matching the trend chart's bucket. */
  key: string;
  credits: number;
}

export interface CreditUsageWindow {
  start_unix: number;
  end_unix: number;
  interval: "day" | "month";
}

export interface CreditUsageResult {
  /** Buckets in ascending order. Empty when the window contains none. */
  points: CreditUsagePoint[];
  /** Credits consumed across the whole selected window. */
  total: number;
  /**
   * Why there is no data, when there is none. Rendered instead of the panel —
   * a vendor outage must never render as "0 credits consumed", which is a
   * measurement, not an absence.
   */
  unavailable: string | null;
  /** The window actually asked for, echoed so the page can state it. */
  window: CreditUsageWindow;
}

/**
 * Translate the page's resolved window into the vendor's parameters.
 *
 * The bucket granularity is TAKEN from the filter, not decided again here, so
 * the credit chart and the call-cost chart beside it are always bucketed the
 * same way. Two charts of the same period at different granularities is how a
 * dashboard invites a false comparison.
 *
 * Bounds are epoch MILLISECONDS — `/v1/usage/character-stats` names its
 * parameters `start_unix`/`end_unix` but reads and returns milliseconds, which
 * is verified against the live account (a month bucket comes back as
 * 1767225600000 = 2026-01-01T00:00:00Z, not 1767225600).
 *
 * `to` is an inclusive IST calendar day, so the end bound is pushed to the end
 * of that day. The vendor's buckets are UTC-aligned; at month granularity that
 * moves at most the first 5h30m of a month between buckets, and the panel says
 * so rather than implying an alignment that does not exist.
 */
export function creditUsageWindow(
  f: ElevenLabsFilters,
  now: Date = new Date(),
): CreditUsageWindow {
  const startFromFilter = f.from ? Date.parse(`${f.from}T00:00:00Z`) : NaN;
  const endFromFilter = f.to ? Date.parse(`${f.to}T23:59:59Z`) : NaN;

  return {
    start_unix: Number.isFinite(startFromFilter)
      ? startFromFilter
      : ALL_TIME_FLOOR_MS,
    // An unbounded `to` means "all time", which ends now.
    end_unix: Number.isFinite(endFromFilter) ? endFromFilter : now.getTime(),
    interval: f.bucket,
  };
}

/**
 * Bucket timestamp → the key the chart uses.
 *
 * Formatted in UTC because the vendor's buckets are UTC-aligned. Formatting
 * them in IST would shift a bucket labelled 2026-06-01 onto 2026-05-31 for
 * exactly the periods where the two calendars disagree, which is worse than
 * naming the offset honestly.
 */
export function bucketKey(ms: number, interval: "day" | "month"): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return interval === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/**
 * Narrow the `/v1/usage/character-stats` payload into keyed points.
 *
 * Shape: `{ time: number[], usage: { <breakdown>: number[] } }`. With no
 * breakdown requested the vendor returns a single "All" series, but the series
 * are summed rather than assuming that key — a future breakdown parameter, or
 * an account with per-workspace splits, would otherwise silently report one
 * slice of the usage as the whole.
 *
 * `usage: {}` WITH a populated `time` array is a real answer, not a broken one:
 * it is what the vendor returns for a window in which nothing was consumed.
 * April 2026 is exactly that window on this account. Rejecting it as
 * unrecognised put "the endpoint may have changed" on screen for a period whose
 * true consumption is zero — the opposite of the honesty rule, which is about
 * not inventing data, not about refusing to report a genuine zero.
 *
 * Returns null only when the payload is not this shape at all, so a genuinely
 * changed API still surfaces as "unavailable" rather than as zero consumption.
 */
export function parseCharacterStats(
  payload: unknown,
  interval: "day" | "month",
): CreditUsagePoint[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as { time?: unknown; usage?: unknown };
  if (!Array.isArray(body.time)) return null;
  if (typeof body.usage !== "object" || body.usage === null) return null;

  const series = Object.values(body.usage as Record<string, unknown>).filter(
    (s): s is unknown[] => Array.isArray(s),
  );

  const points: CreditUsagePoint[] = [];
  body.time.forEach((raw, i) => {
    const key = bucketKey(Number(raw), interval);
    if (!key) return;
    let credits = 0;
    for (const s of series) {
      const value = Number(s[i]);
      if (Number.isFinite(value)) credits += value;
    }
    points.push({ key, credits });
  });

  return points.sort((a, b) => a.key.localeCompare(b.key));
}

interface CacheEntry {
  at: number;
  result: CreditUsageResult;
}

const cache = new Map<string, CacheEntry>();

/**
 * Credits consumed over the selected window, from the vendor's own history.
 *
 * Never throws and never returns zeros for an unknown: every failure path sets
 * `unavailable` and leaves `points` empty, so the page can say "we could not
 * read this" instead of drawing a flat line that means "you used nothing".
 */
export async function fetchCreditUsage(
  f: ElevenLabsFilters,
  now: Date = new Date(),
): Promise<CreditUsageResult> {
  const window = creditUsageWindow(f, now);
  const empty = (unavailable: string): CreditUsageResult => ({
    points: [],
    total: 0,
    unavailable,
    window,
  });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return empty("ELEVENLABS_API_KEY is not set on this host.");
  }

  // Rounded to the minute so a page refresh a second later still hits the
  // cache; the underlying data is bucketed by day at finest.
  const cacheKey = `${Math.floor(window.start_unix / 60_000)}|${Math.floor(
    window.end_unix / 60_000,
  )}|${window.interval}`;
  const hit = cache.get(cacheKey);
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.result;

  const url =
    `${BASE_URL}/v1/usage/character-stats` +
    `?start_unix=${window.start_unix}` +
    `&end_unix=${window.end_unix}` +
    `&aggregation_interval=${window.interval}` +
    // Credits, not characters: credits are what the quota and the balance on
    // the live tiles are denominated in, so the two halves of the page stay
    // comparable. Asking for characters here would produce a chart whose unit
    // silently differs from the tiles above it.
    `&metric=credits`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "xi-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    return empty(
      `ElevenLabs usage API unreachable: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return empty(
      `ElevenLabs usage API returned ${response.status}${
        detail ? `: ${detail.slice(0, 160)}` : ""
      }`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return empty("ElevenLabs usage API returned a body that is not JSON.");
  }

  const points = parseCharacterStats(payload, window.interval);
  if (points == null) {
    return empty(
      "ElevenLabs usage API returned an unrecognised shape — the endpoint may have changed.",
    );
  }

  const result: CreditUsageResult = {
    points,
    total: points.reduce((sum, p) => sum + p.credits, 0),
    unavailable: null,
    window,
  };
  cache.set(cacheKey, { at: now.getTime(), result });
  return result;
}
