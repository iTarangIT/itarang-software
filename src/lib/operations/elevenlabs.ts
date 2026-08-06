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
  categoryLabel,
  fillDays,
  istDay,
  maskPhone,
  momDelta,
  OUTSIDE_MARKER,
  UNCATEGORISED_MARKER,
  type DailyUsage,
  type MonthlyUsage,
} from "./elevenlabsSeries";
import { toNumber } from "./format";
import { getCollectorHealth, type CollectorHealth } from "./runner";
import { latestSamples, seriesFor, type SeriesPoint } from "./samples";

export type { DailyUsage, MonthlyUsage } from "./elevenlabsSeries";

/** The provider string written by src/lib/ai/elevenlabs/finalizeCall.ts. */
const PROVIDER = "elevenlabs" as const;
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

export interface ElevenLabsView {
  credits: ElevenLabsCredits;
  /** 7 days of credits_remaining, hourly buckets, for the sparkline. */
  credits_series: SeriesPoint[];
  /** Month to date, IST. */
  mtd: UsageTotals;
  /** All time. */
  total: UsageTotals;
  first_call_at: Date | null;
  /** Trailing 30 days, one entry per day INCLUDING days with no calls. */
  daily: DailyUsage[];
  /** Six calendar months, newest first. Index 0 is the current partial month. */
  monthly: MonthlyUsage[];
  /** Change between the two most recent COMPLETE months. */
  mom_delta_pct: number | null;
  /** Trailing 30 days. Rows sum to `thirty_day.calls` — see the LEFT JOIN note. */
  by_category: CategoryUsage[];
  thirty_day: UsageTotals;
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

export async function getElevenLabsView(): Promise<ElevenLabsView> {
  const today = istDay();
  const currentMonth = today.slice(0, 7);
  const monthStart = `${currentMonth}-01`;
  const trendStart = istDay(new Date(Date.now() - 29 * 86_400_000));

  const [
    creditSamples,
    creditSeries,
    mtdRows,
    totalRows,
    thirtyRows,
    trendRows,
    monthlyRows,
    categoryRows,
    recentRows,
    firstRows,
    collectors,
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
    rows(buildSummarySql(filters(monthStart, today))),
    rows(buildSummarySql(filters(null, null))),
    rows(buildSummarySql(filters(trendStart, today))),
    rows(buildTrendSql(filters(trendStart, today))),

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
      WHERE acl.call_id IS NOT NULL
        AND acl.provider = ${PROVIDER}
        AND acl.ended_at > NOW() - INTERVAL '30 days'
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
      ORDER BY acl.ended_at DESC
      LIMIT 20
    `),

    rows(sql`
      SELECT MIN(ended_at) AS first_call_at
      FROM ai_call_logs
      WHERE call_id IS NOT NULL AND provider = ${PROVIDER}
    `),

    getCollectorHealth(),
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
  const trend = new Map<string, { calls: number; cost_paise: number }>();
  for (const r of trendRows) {
    // buildTrendSql casts to ::date, which arrives as YYYY-MM-DD already in IST.
    const day = String(r.date).slice(0, 10);
    trend.set(day, { calls: int(r.calls), cost_paise: int(r.cost_cents) });
  }

  const monthly: MonthlyUsage[] = monthlyRows.map((r) => ({
    month: String(r.month),
    calls: int(r.calls),
    cost_paise: int(r.cost_cents),
  }));

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

  return {
    credits,
    credits_series:
      creditSeries.get(`vendor.credits_remaining|${CREDIT_SOURCE}`) ?? [],
    mtd: totals(mtdRows[0]),
    total: totals(totalRows[0]),
    first_call_at: firstCallRaw ? new Date(firstCallRaw as string) : null,
    daily: fillDays(trend, 30),
    monthly,
    mom_delta_pct: momDelta(monthly, currentMonth),
    by_category: byCategory,
    thirty_day: totals(thirtyRows[0]),
    recent,
    collector: collectors.find((c) => c.collector_id === COLLECTOR_ID) ?? null,
    last_updated: lastUpdated,
    current_month: currentMonth,
  };
}
