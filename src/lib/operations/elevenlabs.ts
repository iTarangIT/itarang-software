/**
 * The read model behind /operations/elevenlabs.
 *
 * One question: is the sales team actually using ElevenLabs, and how much are
 * we consuming? Two independent halves answer it.
 *
 *   VENDOR SIDE — credits remaining, quota, tier and reset date. Only
 *     ElevenLabs knows these, so they come from ops_metric_samples, written
 *     hourly by the existing `vendor.elevenlabs` collector. Nothing new is
 *     polled here: this reads the same samples /operations/spend already
 *     renders one tile of.
 *
 *   OUR SIDE — call volume, talk time and metered cost, straight from
 *     ai_call_logs WHERE provider = 'elevenlabs'. Full history already exists
 *     there, and it is the same table the Spend page meters against, so the two
 *     pages cannot disagree.
 *
 * WHY THIS READS ai_call_logs DIRECTLY rather than through samples, the way
 * every module page except Spend does: a daily and monthly SERIES cannot be
 * expressed as a stored scalar per metric, and the data is already in this
 * database. spend.ts made the same call for the same reason.
 *
 * MONEY IS INR PAISE. ai_call_logs.total_cost_cents is ALREADY INR paise for
 * every provider — src/lib/ai/elevenlabs/fetchCallCost.ts converts credits to
 * rupees at fetch time because the account is invoiced in ₹. Never apply an FX
 * rate to it.
 *
 * CREDITS CONSUMED comes from the collector's sample meta (`used`), NOT from
 * cost ÷ rate. The ₹/credit constant is already duplicated in
 * scripts/sync-elevenlabs-conversations.mjs; deriving it here would be a third
 * copy, and the vendor's own character_count is authoritative anyway.
 *
 * The pure helpers live in ./elevenlabsSeries so they can be unit tested — this
 * file imports @/lib/db, which cannot be loaded without a database.
 */

import { sql } from "drizzle-orm";

import {
  buildSummarySql,
  buildTrendSql,
  type CostAnalyticsFilters,
} from "@/lib/campaigns/cost-analytics-query";
import { db } from "@/lib/db";

import {
  addMonths,
  categoryLabel,
  DEFAULT_RANGE,
  fillMonths,
  fillRange,
  istDay,
  istMonth,
  maskPhone,
  momDelta,
  OUTSIDE_MARKER,
  prevRange,
  resolveRange,
  toIsoDay,
  UNCATEGORISED_MARKER,
  type DailyUsage,
  type ElevenLabsFilters,
  type MonthlyUsage,
} from "./elevenlabsSeries";
import { fetchCreditUsage, type CreditUsageResult } from "./elevenlabsUsage";
import { toNumber } from "./format";
import { getCollectorHealth, type CollectorHealth } from "./runner";
import { latestSamples, seriesFor, type SeriesPoint } from "./samples";

export type {
  DailyUsage,
  ElevenLabsFilters,
  MonthlyUsage,
} from "./elevenlabsSeries";

/** The provider string written by src/lib/ai/elevenlabs/finalizeCall.ts. */
const PROVIDER = "elevenlabs" as const;
/**
 * Lower bound for the "all time" totals. Earlier than any call this CRM could
 * hold, so it excludes nothing real — its only job is to make the builder emit
 * an `ended_at >=` predicate, which in turn excludes calls that have not ended.
 */
const ALL_TIME_FLOOR = "2000-01-01" as const;
/** The sample source written by collectors/vendors/elevenlabs.ts. */
const CREDIT_SOURCE = "vendor:elevenlabs";
const COLLECTOR_ID = "vendor.elevenlabs";

const rows = async (
  query: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>>> =>
  (await db.execute(query)) as unknown as Array<Record<string, unknown>>;

const int = (value: unknown): number => toNumber(value) ?? 0;

/**
 * The filter shape the Cost Analytics builders take. page/limit are unused by
 * the summary and trend builders but are required by the type.
 */
function filters(
  from_date: string | null,
  to_date: string | null,
): CostAnalyticsFilters {
  return {
    from_date,
    to_date,
    provider: PROVIDER,
    campaign_id: null,
    page: 1,
    limit: 20,
  };
}

/**
 * The same date window as `filters()`, for the two queries written by hand
 * (category attribution and recent calls) rather than through the shared Cost
 * Analytics builders.
 *
 * It exists so the two cannot drift on the boundary convention: `to` is an
 * INCLUSIVE day, expressed as `< to + 1 day`, exactly as whereClauseAcl does.
 * A hand-written `<= to` here would silently drop the last day's calls on one
 * half of the page and not the other.
 */
/**
 * The window bounds to actually query with.
 *
 * "All time" arrives as `{ from: null, to: null }`, and a null lower bound makes
 * whereClauseAcl omit the `ended_at` predicate entirely — which quietly lets
 * IN-FLIGHT calls (`ended_at IS NULL`) into the figure. On this data that is 53
 * calls: selecting "All time" reported 293 calls against 240 for the last six
 * months, with no calls older than April and nothing on screen to explain the
 * extra 53, while the all-time anchor beside it read 240 because it already
 * used the floor.
 *
 * Substituting the floor here fixes every all-time figure at once — the range
 * totals, the trend, the category breakdown and the recent list — so they all
 * count the same population as the anchor: calls that have ENDED.
 */
function windowBounds(f: ElevenLabsFilters): { from: string; to: string } {
  return { from: f.from ?? ALL_TIME_FLOOR, to: f.to ?? istDay() };
}

function dateBounds(f: ElevenLabsFilters) {
  // IST calendar days, pinned by casting to a naive timestamp before applying
  // the zone — NOT a bare `::date`, which Postgres resolves using the session
  // timezone. Nothing in src/lib/db sets one, so on a UTC server the window was
  // a UTC day while every GROUP BY on this column buckets by IST: a 5h30m skew
  // that put calls made between 00:00 and 05:30 IST on a boundary day into one
  // period for the filter and a different one for the chart. See the matching
  // note on istDayBounds() in cost-analytics-query.ts, which the summary and
  // trend halves of this page go through.
  const { from, to } = windowBounds(f);
  return sql`
    AND acl.ended_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND acl.ended_at <  ((${to}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
  `;
}

export interface ElevenLabsCredits {
  /** vendor.credits_remaining — clamped at zero by the collector. */
  remaining: number | null;
  /** meta.used — characters/credits consumed this billing period. */
  used: number | null;
  /** meta.limit — the billing period's quota. */
  limit: number | null;
  /** vendor.credits_used_pct, 0–100. */
  used_pct: number | null;
  tier: string | null;
  status: string | null;
  /** ISO string; when the quota resets. */
  reset_at: string | null;
  age_minutes: number | null;
}

export interface UsageTotals {
  cost_paise: number;
  calls: number;
  duration_s: number;
  /** Calls carrying a cost. Below `calls` means the cost figure reads low. */
  calls_with_cost: number;
}

export interface CategoryUsage {
  category: string;
  /** False for the "Outside campaign" bucket — a residual, not a category. */
  is_campaign: boolean;
  calls: number;
  cost_paise: number;
  duration_s: number;
}

export interface RecentCall {
  call_id: string;
  ended_at: Date | null;
  status: string | null;
  duration_s: number | null;
  cost_paise: number | null;
  campaign: string | null;
  phone_masked: string | null;
}

/**
 * One bar on the trend chart. `key` is YYYY-MM-DD for day buckets and YYYY-MM
 * for month buckets, so the chart renders from one shape either way.
 */
export interface TrendPoint {
  key: string;
  calls: number;
  cost_paise: number;
}

export interface ElevenLabsView {
  /** The resolved window everything below (except where noted) is scoped to. */
  filters: ElevenLabsFilters;
  /**
   * LIVE — the vendor account as it stands right now. Not affected by the date
   * filter, and structurally incapable of being: it is a balance, not a series.
   */
  credits: ElevenLabsCredits;
  /** 7 days of credits_remaining, hourly buckets, for the sparkline. */
  credits_series: SeriesPoint[];
  /**
   * HISTORICAL — credits actually consumed inside the selected window, from
   * the vendor's own usage history. This is the number the live tiles cannot
   * give: `credits.used` is consumption in the CURRENT billing period, whatever
   * window is selected.
   */
  credit_usage: CreditUsageResult;
  /** Totals for the selected range. */
  range: UsageTotals;
  /**
   * The equally-long window immediately before it, for the "vs previous" hint.
   * Null for all time, which has no predecessor.
   */
  prev: UsageTotals | null;
  /**
   * All time — every call that has ENDED, not range-filtered. The absolute
   * anchor the page prints as context. In-flight calls are excluded so this
   * counts the same population as every windowed figure beside it.
   */
  total: UsageTotals;
  first_call_at: Date | null;
  /** The selected range, gaps filled. Granularity follows `filters.bucket`. */
  trend: TrendPoint[];
  /**
   * Six calendar months, newest first. Index 0 is the current partial month.
   * DELIBERATELY NOT filtered — this chart is the navigation context (you see
   * the spike, you pick that month), and momDelta is defined on complete
   * calendar months, so a range-relative version would mean nothing.
   */
  monthly: MonthlyUsage[];
  /** Change between the two most recent COMPLETE months. */
  mom_delta_pct: number | null;
  /** Selected range. Rows sum to `range.calls` — see the LEFT JOIN note. */
  by_category: CategoryUsage[];
  recent: RecentCall[];
  collector: CollectorHealth | null;
  /** Newest captured_at across the credit samples. */
  last_updated: Date | null;
  /** YYYY-MM in IST — the page marks this month's bar as partial. */
  current_month: string;
}

/** buildSummarySql returns one row in a fixed shape; unpack it in one place. */
function totals(row: Record<string, unknown> | undefined): UsageTotals {
  return {
    cost_paise: int(row?.total_cost_cents),
    calls: int(row?.total_calls),
    duration_s: int(row?.total_duration_secs),
    calls_with_cost: int(row?.calls_with_cost),
  };
}

/**
 * @param f The resolved date window. Defaults to month-to-date, which keeps the
 *   two existing call sites (the page and the JSON route) compiling unchanged
 *   and preserves the pre-filter behaviour for anything that forgets to pass one.
 */
export async function getElevenLabsView(
  f: ElevenLabsFilters = resolveRange(DEFAULT_RANGE),
): Promise<ElevenLabsView> {
  const today = istDay();
  const currentMonth = istMonth();
  const previous = prevRange(f);
  // Resolved once and used by every query below, so the summary, the trend, the
  // category breakdown and the recent list cannot disagree about what "all
  // time" means. See windowBounds().
  const bounds = windowBounds(f);

  const [
    creditSamples,
    creditSeries,
    rangeRows,
    totalRows,
    prevRows,
    trendRows,
    monthlyRows,
    categoryRows,
    recentRows,
    firstRows,
    collectors,
    creditUsage,
  ] = await Promise.all([
    // 48 hours, matching spend.ts: the collector runs hourly, so a 24h window
    // would show "no credit data" after a single missed cycle.
    latestSamples(["vendor.credits_remaining", "vendor.credits_used_pct"], {
      maxAgeHours: 48,
    }),
    seriesFor(["vendor.credits_remaining"], {
      hours: 24 * 7,
      bucketMinutes: 60,
    }),

    // Reused verbatim from Cost Analytics so both surfaces report the same
    // numbers for the same window. Neither joins dialer_campaign_leads — that
    // join is what made Cost Analytics read ~5x low before May 2026.
    //
    // The builders already take nullable bounds (whereClauseAcl omits each
    // clause when null), which is why supporting a date filter needed no change
    // to cost-analytics-query.ts at all.
    rows(buildSummarySql(filters(bounds.from, bounds.to))),
    // All time — but bounded below rather than left unbounded, so it counts
    // the same population every windowed figure on this page counts.
    //
    // whereClauseAcl omits the ended_at predicate entirely when from_date is
    // null, which quietly lets IN-FLIGHT calls (ended_at IS NULL) into this one
    // number and no other. On this data that is 53 calls: the tile read "293
    // calls" all-time against "240" for the last six months, with no calls
    // older than April and no way to see where the extra 53 came from. An epoch
    // floor restores `ended_at IS NOT NULL` without touching the shared builder
    // that Cost Analytics also depends on.
    rows(buildSummarySql(filters(ALL_TIME_FLOOR, istDay()))),
    previous
      ? rows(buildSummarySql(filters(previous.from, previous.to)))
      : Promise.resolve([]),

    // Day buckets go through the shared trend builder; month buckets need a
    // GROUP BY the SQL builder does not express, and running the day builder
    // over an all-time window would return a row per day since the first call.
    f.bucket === "day"
      ? rows(buildTrendSql(filters(bounds.from, bounds.to)))
      : rows(sql`
          SELECT
            TO_CHAR(acl.ended_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
            COALESCE(SUM(acl.total_cost_cents), 0)::bigint               AS cost_cents,
            COUNT(*)::int                                                AS calls
          FROM ai_call_logs acl
          WHERE acl.call_id IS NOT NULL
            AND acl.provider = ${PROVIDER}
            AND acl.ended_at IS NOT NULL
            ${dateBounds(f)}
          GROUP BY 1
        `),

    // Six calendar months. Bounded by DATE_TRUNC rather than
    // `NOW() - INTERVAL '6 months'` so the oldest bucket is a whole month, not
    // a fragment that reads as a collapse in usage. The naive IST timestamp is
    // converted back to timestamptz before comparing, so the boundary is
    // midnight IST rather than midnight in the server's timezone.
    rows(sql`
      SELECT
        TO_CHAR(ended_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
        COALESCE(SUM(total_cost_cents), 0)::bigint               AS cost_cents,
        COUNT(*)::int                                            AS calls
      FROM ai_call_logs
      WHERE call_id IS NOT NULL
        AND provider = ${PROVIDER}
        AND ended_at IS NOT NULL
        AND ended_at >= (
          (DATE_TRUNC('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))
            - INTERVAL '5 months') AT TIME ZONE 'Asia/Kolkata'
        )
      GROUP BY month
      ORDER BY month DESC
    `),

    // Usage by workflow. ai_call_logs has no workflow/category column, so the
    // dimension is the campaign's category, reached through
    // dialer_campaign_leads.bolna_call_id (which holds the ElevenLabs
    // conversation_id too, despite the name).
    //
    // LEFT JOIN LATERAL, and never an INNER JOIN. Two reasons, both load-bearing:
    //   · calls placed outside a campaign, and campaign calls whose webhook
    //     dropped, have NO dcl row. An inner join silently discards them — the
    //     ~5x undercount documented in cost-analytics-query.ts. They land in the
    //     "Outside campaign" bucket instead, so these rows still sum to the
    //     headline 30-day total (the page asserts exactly that).
    //   · LATERAL … LIMIT 1 rather than a plain LEFT JOIN because one call_id
    //     can match several dcl rows (a lead re-queued into a second campaign),
    //     and a plain join would count that call twice.
    rows(sql`
      SELECT
        CASE
          WHEN dcl.campaign_id IS NULL THEN ${OUTSIDE_MARKER}
          ELSE COALESCE(NULLIF(TRIM(dc.category), ''), ${UNCATEGORISED_MARKER})
        END                                            AS category,
        COUNT(*)::int                                  AS calls,
        COALESCE(SUM(acl.total_cost_cents), 0)::bigint AS cost_cents,
        COALESCE(SUM(acl.call_duration), 0)::bigint    AS duration_s
      FROM ai_call_logs acl
      LEFT JOIN LATERAL (
        SELECT d.campaign_id
        FROM dialer_campaign_leads d
        WHERE d.bolna_call_id = acl.call_id
        ORDER BY d.created_at DESC
        LIMIT 1
      ) dcl ON TRUE
      LEFT JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
      -- No explicit "ended_at IS NOT NULL": dateBounds() now always emits an
      -- ended_at predicate, including on "all time" (windowBounds substitutes
      -- the epoch floor), and a NULL fails it. So in-flight calls are excluded
      -- from this breakdown and from the headline by the same rule, and the
      -- page's "attribution join is losing rows" warning stays meaningful
      -- rather than firing on a difference that was only ever a NULL policy.
      WHERE acl.call_id IS NOT NULL
        AND acl.provider = ${PROVIDER}
        ${dateBounds(f)}
      GROUP BY 1
      ORDER BY calls DESC
    `),

    // Deliberately NOT buildCallDetailSql — that builder inner-joins
    // dialer_campaign_leads, so a "recent activity" list built on it would omit
    // every call placed outside a campaign, which is the population this page
    // most needs to show.
    rows(sql`
      SELECT
        acl.call_id          AS call_id,
        acl.ended_at         AS ended_at,
        acl.status           AS status,
        acl.call_duration    AS duration_s,
        acl.total_cost_cents AS cost_cents,
        acl.phone_number     AS phone_number,
        dc.name              AS campaign
      FROM ai_call_logs acl
      LEFT JOIN LATERAL (
        SELECT d.campaign_id
        FROM dialer_campaign_leads d
        WHERE d.bolna_call_id = acl.call_id
        ORDER BY d.created_at DESC
        LIMIT 1
      ) dcl ON TRUE
      LEFT JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
      WHERE acl.call_id IS NOT NULL
        AND acl.provider = ${PROVIDER}
        AND acl.ended_at IS NOT NULL
        ${dateBounds(f)}
      ORDER BY acl.ended_at DESC
      LIMIT 20
    `),

    rows(sql`
      SELECT MIN(ended_at) AS first_call_at
      FROM ai_call_logs
      WHERE call_id IS NOT NULL AND provider = ${PROVIDER}
    `),

    getCollectorHealth(),

    // The vendor's own usage history for the SELECTED window — the only source
    // that can answer "how many credits did we burn in May". Never throws: a
    // failure comes back as `unavailable` with the reason, so the panel says it
    // could not read rather than drawing zero consumption.
    fetchCreditUsage(f),
  ]);

  // ---- vendor side: credits -------------------------------------------------
  const remaining = creditSamples.find(
    (s) =>
      s.metric_key === "vendor.credits_remaining" && s.source === CREDIT_SOURCE,
  );
  const usedPct = creditSamples.find(
    (s) =>
      s.metric_key === "vendor.credits_used_pct" && s.source === CREDIT_SOURCE,
  );
  const meta = (remaining?.meta ?? usedPct?.meta ?? {}) as Record<
    string,
    unknown
  >;

  const credits: ElevenLabsCredits = {
    remaining: remaining?.value_num ?? null,
    used: toNumber(meta.used),
    limit: toNumber(meta.limit),
    used_pct: usedPct?.value_num ?? null,
    tier: typeof meta.tier === "string" ? meta.tier : null,
    status: typeof meta.status === "string" ? meta.status : null,
    reset_at: typeof meta.reset_at === "string" ? meta.reset_at : null,
    age_minutes: remaining?.age_minutes ?? usedPct?.age_minutes ?? null,
  };

  const lastUpdated = [remaining?.captured_at, usedPct?.captured_at].reduce<
    Date | null
  >((newest, at) => (at && (!newest || at > newest) ? at : newest), null);

  // ---- our side: usage ------------------------------------------------------
  const found = new Map<string, { calls: number; cost_paise: number }>();
  for (const r of trendRows) {
    // buildTrendSql casts to ::date, which postgres.js hands back as a Date
    // object — NOT the "YYYY-MM-DD" string this used to assume. toIsoDay()
    // normalises both shapes; see its doc comment for the outage it fixes.
    // The month branch selects a YYYY-MM string via TO_CHAR and needs no help.
    const key = f.bucket === "day" ? toIsoDay(r.date) : String(r.month);
    if (!key) continue;
    found.set(key, { calls: int(r.calls), cost_paise: int(r.cost_cents) });
  }

  // Gap-filled across whole calendar months. Without this a month with no
  // ElevenLabs calls produces no row and simply vanishes, so six evenly-spaced
  // bars can silently be March, May, July and August — a chart that draws a gap
  // as continuity. July 2026 is exactly that case on this data.
  const monthlyFound = new Map<string, { calls: number; cost_paise: number }>();
  for (const r of monthlyRows) {
    monthlyFound.set(String(r.month), {
      calls: int(r.calls),
      cost_paise: int(r.cost_cents),
    });
  }
  const monthly: MonthlyUsage[] = fillMonths(
    monthlyFound,
    `${addMonths(currentMonth, -5)}-01`,
    `${currentMonth}-01`,
  )
    // fillMonths returns oldest-first; this array is documented newest-first,
    // with index 0 the current partial month, and momDelta relies on that.
    .reverse();

  const byCategory: CategoryUsage[] = categoryRows.map((r) => {
    const { category, is_campaign } = categoryLabel(String(r.category));
    return {
      category,
      is_campaign,
      calls: int(r.calls),
      cost_paise: int(r.cost_cents),
      duration_s: int(r.duration_s),
    };
  });

  const recent: RecentCall[] = recentRows.map((r) => ({
    call_id: String(r.call_id),
    ended_at: r.ended_at ? new Date(r.ended_at as string) : null,
    status: (r.status as string) ?? null,
    duration_s: toNumber(r.duration_s),
    cost_paise: toNumber(r.cost_cents),
    campaign: (r.campaign as string) ?? null,
    phone_masked: maskPhone(r.phone_number),
  }));

  const firstCallRaw = firstRows[0]?.first_call_at;
  const firstCallAt = firstCallRaw ? new Date(firstCallRaw as string) : null;

  // All time has no stored bounds, so the chart is bounded by the data itself:
  // the first call ever through today. Without this the "all" window would have
  // nothing to enumerate between.
  const chartFrom = f.from ?? (firstCallAt ? istDay(firstCallAt) : today);
  const chartTo = f.to ?? today;
  const trend: TrendPoint[] =
    f.bucket === "day"
      ? fillRange(found, chartFrom, chartTo).map((d) => ({
          key: d.day,
          calls: d.calls,
          cost_paise: d.cost_paise,
        }))
      : fillMonths(found, chartFrom, chartTo).map((m) => ({
          key: m.month,
          calls: m.calls,
          cost_paise: m.cost_paise,
        }));

  return {
    filters: f,
    credits,
    credits_series:
      creditSeries.get(`vendor.credits_remaining|${CREDIT_SOURCE}`) ?? [],
    credit_usage: creditUsage,
    range: totals(rangeRows[0]),
    prev: previous ? totals(prevRows[0]) : null,
    total: totals(totalRows[0]),
    first_call_at: firstCallAt,
    trend,
    monthly,
    mom_delta_pct: momDelta(monthly, currentMonth),
    by_category: byCategory,
    recent,
    collector: collectors.find((c) => c.collector_id === COLLECTOR_ID) ?? null,
    last_updated: lastUpdated,
    current_month: currentMonth,
  };
}
