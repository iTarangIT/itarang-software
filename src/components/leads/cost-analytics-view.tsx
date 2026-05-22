// Top-level container for the Cost Analytics tab on /leads. Owns filter
// state, fetches /api/campaigns/cost-analytics via React Query, and lays
// out the dashboard. Pattern lifted from sales-insight/ConvertedInsightView
// — filters serialize into the query key so React Query handles caching
// and the URL stays in sync.

"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";

import { FiltersBar } from "./cost-analytics/FiltersBar";
import { KPIRow } from "./cost-analytics/KPIRow";
import { CostTrendChart } from "./cost-analytics/CostTrendChart";
import { ComponentBreakdownChart } from "./cost-analytics/ComponentBreakdownChart";
import { ProviderDonut } from "./cost-analytics/ProviderDonut";
import { TopCampaignsTable } from "./cost-analytics/TopCampaignsTable";
import { CallDetailDrawer } from "./cost-analytics/CallDetailDrawer";
import { ExportButton } from "./cost-analytics/ExportButton";
import type {
  CostAnalyticsFilters,
  CostAnalyticsResponse,
} from "./cost-analytics/types";

type CampaignLite = {
  id: string;
  name: string;
  status: string;
  provider: string;
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildQueryString(filters: CostAnalyticsFilters, campaignId?: string | null): string {
  const params = new URLSearchParams();
  if (filters.from_date) params.set("from_date", filters.from_date);
  if (filters.to_date) params.set("to_date", filters.to_date);
  if (filters.provider) params.set("provider", filters.provider);
  if (campaignId) params.set("campaign_id", campaignId);
  return params.toString();
}

export function CostAnalyticsView() {
  // Default: last 30 days. Matches the most common finance review cadence.
  const [filters, setFilters] = useState<CostAnalyticsFilters>({
    from_date: isoDaysAgo(30),
    to_date: todayIso(),
    provider: null,
    campaign_id: null,
  });

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null,
  );

  // Pull the campaign list for the filter dropdown. Cheap query — runs
  // once per provider scope. Response shape: { success, data: { data: rows[], page } }
  // (preserved from the existing CampaignsTable contract).
  const campaignsQuery = useQuery<{
    success: boolean;
    data: { data: CampaignLite[]; page: number };
  }>({
    queryKey: ["cost-analytics-campaign-list", filters.provider],
    queryFn: async () => {
      const url = filters.provider
        ? `/api/ai-dialer/campaigns?provider=${filters.provider}&limit=200`
        : `/api/ai-dialer/campaigns?limit=200`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load campaigns");
      return res.json();
    },
    staleTime: 60_000,
  });

  const campaignOptions = useMemo(
    () =>
      (campaignsQuery.data?.data?.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [campaignsQuery.data],
  );

  // Main analytics query — aggregates for the whole view. Selecting a
  // campaign re-fetches with campaign_id to pull per-call detail too.
  const analyticsQuery = useQuery<CostAnalyticsResponse>({
    queryKey: [
      "campaigns-cost-analytics",
      filters.from_date,
      filters.to_date,
      filters.provider,
      selectedCampaignId,
    ],
    queryFn: async () => {
      const qs = buildQueryString(filters, selectedCampaignId);
      const res = await fetch(
        `/api/campaigns/cost-analytics${qs ? `?${qs}` : ""}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const handleFilterChange = useCallback((next: CostAnalyticsFilters) => {
    setFilters(next);
    setSelectedCampaignId(null); // clear drill-in when filter changes
  }, []);

  const refresh = useCallback(() => {
    analyticsQuery.refetch();
  }, [analyticsQuery]);

  const data = analyticsQuery.data;
  const loading = analyticsQuery.isLoading;
  const refreshing = analyticsQuery.isFetching && !analyticsQuery.isLoading;
  const error = analyticsQuery.error as Error | null;

  const exportFilters: CostAnalyticsFilters = {
    ...filters,
    campaign_id: selectedCampaignId,
  };

  const selectedCampaignName =
    data?.topCampaigns.find((c) => c.id === selectedCampaignId)?.name ??
    campaignOptions.find((c) => c.id === selectedCampaignId)?.name ??
    "Campaign";

  return (
    <div className="space-y-5">
      {/* Section title — separates this tab visually from the leads table */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 rounded-lg bg-emerald-100">
              <Wallet className="w-3.5 h-3.5 text-emerald-700" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700">
              Cost analytics
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-gray-900">
            Where AI dialer spend is going
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Per-call cost captured from Bolna and ElevenLabs, rolled up
            across campaigns.
          </p>
        </div>
        <ExportButton filters={exportFilters} disabled={loading} />
      </div>

      <FiltersBar
        filters={filters}
        campaigns={campaignOptions}
        onChange={handleFilterChange}
        onRefresh={refresh}
        refreshing={refreshing}
      />

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <div className="font-semibold mb-0.5">
            Couldn&apos;t load cost data
          </div>
          <div className="text-[12px] text-rose-700 break-all">
            {error.message}
          </div>
        </div>
      )}

      <KPIRow
        summary={
          data?.summary ?? {
            totalCostCents: 0,
            totalCalls: 0,
            totalDurationSecs: 0,
            avgCostPerCallCents: 0,
            avgCostPerMinuteCents: 0,
            coverage: { withCost: 0, total: 0 },
          }
        }
        loading={loading}
      />

      <CostTrendChart data={data?.trend ?? []} loading={loading} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ComponentBreakdownChart
          data={
            data?.componentBreakdown ?? {
              llm: 0,
              tts: 0,
              stt: 0,
              telephony: 0,
              platform: 0,
            }
          }
          loading={loading}
        />
        <ProviderDonut data={data?.providerSplit ?? []} loading={loading} />
      </div>

      <TopCampaignsTable
        campaigns={data?.topCampaigns ?? []}
        selectedId={selectedCampaignId}
        onSelect={setSelectedCampaignId}
        loading={loading}
      />

      <CallDetailDrawer
        open={!!selectedCampaignId}
        campaignName={selectedCampaignName}
        calls={data?.calls ?? []}
        total={data?.callsTotal ?? 0}
        loading={analyticsQuery.isFetching}
        onClose={() => setSelectedCampaignId(null)}
      />
    </div>
  );
}
