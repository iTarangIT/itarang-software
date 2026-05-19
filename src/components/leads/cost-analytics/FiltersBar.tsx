// Filter strip for the Cost Analytics dashboard. Sticks to the editorial
// tone — eyebrow labels above each control, date range presented as the
// dominant pair, provider and campaign as secondary filters.
//
// Stays controlled (filter state lives in CostAnalyticsView) so the URL,
// React Query key, and CSV export all stay in lockstep.

"use client";

import { CalendarRange, ChevronDown, RefreshCw } from "lucide-react";
import type { CostAnalyticsFilters, ProviderKey } from "./types";

type Campaign = { id: string; name: string };

type FiltersBarProps = {
  filters: CostAnalyticsFilters;
  campaigns: Campaign[];
  onChange: (next: CostAnalyticsFilters) => void;
  onRefresh: () => void;
  refreshing?: boolean;
};

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function FiltersBar({
  filters,
  campaigns,
  onChange,
  onRefresh,
  refreshing,
}: FiltersBarProps) {
  const setField = <K extends keyof CostAnalyticsFilters>(
    key: K,
    value: CostAnalyticsFilters[K],
  ) => onChange({ ...filters, [key]: value });

  const applyPreset = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);
    onChange({
      ...filters,
      from_date: isoDate(from),
      to_date: isoDate(to),
    });
  };

  const presetActive = (days: number): boolean => {
    if (!filters.from_date || !filters.to_date) return false;
    const to = new Date(filters.to_date);
    const from = new Date(filters.from_date);
    const diff = Math.round(
      (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000),
    );
    return Math.abs(diff - days) <= 1;
  };

  return (
    <div className="bg-white border border-gray-200 rounded-2xl px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        {/* Date range — the dominant control */}
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <CalendarRange className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
                Date range
              </span>
            </div>
            <div className="flex items-center gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p.days)}
                  className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${
                    presetActive(p.days)
                      ? "bg-gray-900 text-white"
                      : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={filters.from_date ?? ""}
              onChange={(e) =>
                setField("from_date", e.target.value || null)
              }
              className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 tabular-nums"
            />
            <span className="text-gray-300 text-xs shrink-0">→</span>
            <input
              type="date"
              value={filters.to_date ?? ""}
              onChange={(e) => setField("to_date", e.target.value || null)}
              className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 tabular-nums"
            />
          </div>
        </div>

        {/* Provider */}
        <div className="min-w-[160px]">
          <div className="mb-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
              Provider
            </span>
          </div>
          <div className="relative">
            <select
              value={filters.provider ?? ""}
              onChange={(e) =>
                setField(
                  "provider",
                  (e.target.value || null) as ProviderKey | null,
                )
              }
              className="w-full appearance-none px-3 py-2 pr-8 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="">All providers</option>
              <option value="bolna">Bolna</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          </div>
        </div>

        {/* Campaign */}
        <div className="min-w-[220px]">
          <div className="mb-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
              Campaign
            </span>
          </div>
          <div className="relative">
            <select
              value={filters.campaign_id ?? ""}
              onChange={(e) =>
                setField("campaign_id", e.target.value || null)
              }
              className="w-full appearance-none px-3 py-2 pr-8 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 cursor-pointer truncate"
            >
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          </div>
        </div>

        {/* Refresh */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
    </div>
  );
}
