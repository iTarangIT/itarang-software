// Wire types for /api/campaigns/cost-analytics. Mirrors the JSON shape
// returned by src/app/api/campaigns/cost-analytics/route.ts.

export type ProviderKey = "bolna" | "elevenlabs";

export type CostAnalyticsFilters = {
  from_date: string | null;
  to_date: string | null;
  provider: ProviderKey | null;
  campaign_id: string | null;
};

export type SummaryKPI = {
  totalCostCents: number;
  totalCalls: number;
  totalDurationSecs: number;
  avgCostPerCallCents: number;
  avgCostPerMinuteCents: number;
  coverage: { withCost: number; total: number };
};

export type TrendPoint = {
  date: string;
  costCents: number;
  calls: number;
};

export type ComponentBreakdown = {
  llm: number;
  tts: number;
  stt: number;
  telephony: number;
  platform: number;
};

export type ProviderSplit = {
  provider: ProviderKey;
  costCents: number;
  calls: number;
  durationSecs: number;
};

export type TopCampaign = {
  id: string;
  name: string;
  provider: ProviderKey;
  callsMade: number;
  totalLeads: number;
  startedAt: string | null;
  totalCostCents: number;
  costCalls: number;
  avgCostPerCallCents: number;
  totalDurationSecs: number;
};

export type CallDetail = {
  callId: string;
  leadId: string | null;
  provider: ProviderKey;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSecs: number | null;
  totalCostCents: number | null;
  components: {
    llm: number | null;
    tts: number | null;
    stt: number | null;
    telephony: number | null;
    platform: number | null;
  };
  costFetchedAt: string | null;
  shopName: string | null;
  phone: string | null;
};

export type CostAnalyticsResponse = {
  success: true;
  summary: SummaryKPI;
  trend: TrendPoint[];
  componentBreakdown: ComponentBreakdown;
  providerSplit: ProviderSplit[];
  topCampaigns: TopCampaign[];
  calls?: CallDetail[];
  callsTotal?: number;
  callsPage?: number;
  callsLimit?: number;
};
