// GET /api/campaigns/cost-analytics
//
// Aggregations for the new Cost Analytics tab on /leads. Joins
// dialer_campaigns ⋈ dialer_campaign_leads ⋈ ai_call_logs and returns the
// five panels (summary, trend, component breakdown, provider split,
// top campaigns) in one round-trip so React Query has a single cache key.
//
// Optional `campaign_id` flips on a sixth section: paginated per-call
// detail for the drawer that opens when you click a campaign row.
//
// Date range filters on ai_call_logs.ended_at (call date, not campaign
// start) — see cost-analytics-query.ts.

import { db } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { NextResponse } from "next/server";
import {
  buildSummarySql,
  buildTrendSql,
  buildComponentBreakdownSql,
  buildProviderSplitSql,
  buildTopCampaignsSql,
  buildCallDetailSql,
  buildCallDetailCountSql,
  type CostAnalyticsFilters,
} from "@/lib/campaigns/cost-analytics-query";

const ALLOWED_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "admin",
] as const;

function parseFilters(searchParams: URLSearchParams): CostAnalyticsFilters {
  const provider = searchParams.get("provider");
  const validProvider =
    provider === "bolna" || provider === "elevenlabs" ? provider : null;
  return {
    from_date: searchParams.get("from_date") || null,
    to_date: searchParams.get("to_date") || null,
    provider: validProvider,
    campaign_id: searchParams.get("campaign_id") || null,
    page: Math.max(1, Number(searchParams.get("page") || 1)),
    limit: Math.min(
      200,
      Math.max(1, Number(searchParams.get("limit") || 50)),
    ),
  };
}

type SummaryRow = {
  total_cost_cents: string | number;
  total_calls: number;
  total_duration_secs: string | number;
  calls_with_cost: number;
};

type TrendRow = {
  date: string;
  cost_cents: string | number;
  calls: number;
};

type ComponentRow = {
  llm: string | number;
  tts: string | number;
  stt: string | number;
  telephony: string | number;
  platform: string | number;
};

type ProviderRow = {
  provider: string;
  cost_cents: string | number;
  calls: number;
  duration_secs: string | number;
};

type TopCampaignRow = {
  id: string;
  name: string;
  provider: string;
  calls_made: number;
  total_leads: number;
  started_at: string | null;
  total_cost_cents: string | number;
  cost_calls: number;
  total_duration_secs: string | number;
};

type CallDetailRow = {
  call_id: string;
  lead_id: string | null;
  provider: string;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_secs: number | null;
  total_cost_cents: number | null;
  llm_cost_cents: number | null;
  tts_cost_cents: number | null;
  stt_cost_cents: number | null;
  telephony_cost_cents: number | null;
  platform_cost_cents: number | null;
  cost_fetched_at: string | null;
  shop_name: string | null;
  phone: string | null;
};

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : Number(v);
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...ALLOWED_ROLES]);

  const { searchParams } = new URL(req.url);
  const filters = parseFilters(searchParams);

  const tasks: Promise<unknown>[] = [
    db.execute(buildSummarySql(filters)),
    db.execute(buildTrendSql(filters)),
    db.execute(buildComponentBreakdownSql(filters)),
    db.execute(buildProviderSplitSql(filters)),
    db.execute(buildTopCampaignsSql(filters)),
  ];

  if (filters.campaign_id) {
    tasks.push(db.execute(buildCallDetailSql(filters)));
    tasks.push(db.execute(buildCallDetailCountSql(filters)));
  }

  const results = await Promise.all(tasks);
  const summaryResult = results[0] as unknown as { rows: SummaryRow[] } | SummaryRow[];
  const trendResult = results[1] as unknown as { rows: TrendRow[] } | TrendRow[];
  const componentResult = results[2] as unknown as { rows: ComponentRow[] } | ComponentRow[];
  const providerResult = results[3] as unknown as { rows: ProviderRow[] } | ProviderRow[];
  const topCampaignsResult = results[4] as unknown as { rows: TopCampaignRow[] } | TopCampaignRow[];

  // Drizzle's pg execute returns { rows: [...] } in some versions and a
  // bare array in others. Normalize.
  function unwrap<T>(r: { rows: T[] } | T[]): T[] {
    if (Array.isArray(r)) return r;
    return r.rows ?? [];
  }

  const summaryRow = unwrap(summaryResult)[0] ?? {
    total_cost_cents: 0,
    total_calls: 0,
    total_duration_secs: 0,
    calls_with_cost: 0,
  };

  const totalCostCents = num(summaryRow.total_cost_cents);
  const totalCalls = num(summaryRow.total_calls);
  const totalDurationSecs = num(summaryRow.total_duration_secs);
  const callsWithCost = num(summaryRow.calls_with_cost);

  const summary = {
    totalCostCents,
    totalCalls,
    totalDurationSecs,
    avgCostPerCallCents:
      callsWithCost > 0 ? Math.round(totalCostCents / callsWithCost) : 0,
    avgCostPerMinuteCents:
      totalDurationSecs > 0
        ? Math.round((totalCostCents / totalDurationSecs) * 60)
        : 0,
    coverage: { withCost: callsWithCost, total: totalCalls },
  };

  const trend = unwrap(trendResult).map((r) => ({
    date: typeof r.date === "string" ? r.date.slice(0, 10) : String(r.date).slice(0, 10),
    costCents: num(r.cost_cents),
    calls: num(r.calls),
  }));

  const componentRow = unwrap(componentResult)[0] ?? {
    llm: 0,
    tts: 0,
    stt: 0,
    telephony: 0,
    platform: 0,
  };
  const componentBreakdown = {
    llm: num(componentRow.llm),
    tts: num(componentRow.tts),
    stt: num(componentRow.stt),
    telephony: num(componentRow.telephony),
    platform: num(componentRow.platform),
  };

  const providerSplit = unwrap(providerResult).map((r) => ({
    provider: r.provider,
    costCents: num(r.cost_cents),
    calls: num(r.calls),
    durationSecs: num(r.duration_secs),
  }));

  const topCampaigns = unwrap(topCampaignsResult).map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    callsMade: num(r.calls_made),
    totalLeads: num(r.total_leads),
    startedAt: r.started_at,
    totalCostCents: num(r.total_cost_cents),
    costCalls: num(r.cost_calls),
    avgCostPerCallCents:
      num(r.cost_calls) > 0
        ? Math.round(num(r.total_cost_cents) / num(r.cost_calls))
        : 0,
    totalDurationSecs: num(r.total_duration_secs),
  }));

  const response: Record<string, unknown> = {
    success: true,
    summary,
    trend,
    componentBreakdown,
    providerSplit,
    topCampaigns,
  };

  if (filters.campaign_id) {
    const detailResult = results[5] as unknown as
      | { rows: CallDetailRow[] }
      | CallDetailRow[];
    const countResult = results[6] as unknown as
      | { rows: Array<{ count: number }> }
      | Array<{ count: number }>;
    response.calls = unwrap(detailResult).map((r) => ({
      callId: r.call_id,
      leadId: r.lead_id,
      provider: r.provider,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationSecs: r.duration_secs,
      totalCostCents: r.total_cost_cents,
      components: {
        llm: r.llm_cost_cents,
        tts: r.tts_cost_cents,
        stt: r.stt_cost_cents,
        telephony: r.telephony_cost_cents,
        platform: r.platform_cost_cents,
      },
      costFetchedAt: r.cost_fetched_at,
      shopName: r.shop_name,
      phone: r.phone,
    }));
    response.callsTotal = num(unwrap(countResult)[0]?.count ?? 0);
    response.callsPage = filters.page;
    response.callsLimit = filters.limit;
  }

  return NextResponse.json(response);
});
