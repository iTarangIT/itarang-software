// Top campaigns by spend. Row click selects the campaign, which lifts
// state up to CostAnalyticsView, refetches with campaign_id, and opens
// the per-call detail drawer.

"use client";

import { Crown, ChevronRight } from "lucide-react";
import { formatINR, formatINRDetailed } from "@/lib/currency";
import type { TopCampaign } from "./types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "2-digit",
  });
}

function providerChip(p: string) {
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    bolna: { bg: "bg-blue-50", text: "text-blue-700", label: "Bolna" },
    elevenlabs: {
      bg: "bg-violet-50",
      text: "text-violet-700",
      label: "ElevenLabs",
    },
  };
  const c = cfg[p] ?? { bg: "bg-gray-100", text: "text-gray-600", label: p };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold rounded-full ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  );
}

type TopCampaignsTableProps = {
  campaigns: TopCampaign[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading?: boolean;
};

export function TopCampaignsTable({
  campaigns,
  selectedId,
  onSelect,
  loading,
}: TopCampaignsTableProps) {
  const grandTotal = campaigns.reduce(
    (s, c) => s + c.totalCostCents,
    0,
  );

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-gray-100">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Crown className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
              Top campaigns by spend
            </span>
          </div>
          <h3 className="text-base font-bold text-gray-900 tracking-tight">
            Where budget is going
          </h3>
        </div>
        {selectedId && (
          <button
            onClick={() => onSelect(null)}
            className="text-xs font-medium text-gray-500 hover:text-gray-900 transition-colors"
          >
            Clear selection
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-6 py-2.5 font-bold">Campaign</th>
              <th className="text-left px-3 py-2.5 font-bold">Provider</th>
              <th className="text-right px-3 py-2.5 font-bold">Started</th>
              <th className="text-right px-3 py-2.5 font-bold">Calls</th>
              <th className="text-right px-3 py-2.5 font-bold">Avg / Call</th>
              <th className="text-right px-3 py-2.5 font-bold pr-6">
                Total Spend
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && campaigns.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-400">
                  Loading…
                </td>
              </tr>
            ) : campaigns.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center">
                  <div className="text-sm text-gray-500 font-medium">
                    No campaigns with cost data
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Cost arrives a few seconds after each call. Try
                    widening the date range.
                  </p>
                </td>
              </tr>
            ) : (
              campaigns.map((c) => {
                const isSelected = c.id === selectedId;
                const share =
                  grandTotal > 0
                    ? (c.totalCostCents / grandTotal) * 100
                    : 0;
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelect(isSelected ? null : c.id)}
                    className={`border-b border-gray-50 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-emerald-50/30"
                        : "hover:bg-gray-50/60"
                    }`}
                  >
                    <td className="px-6 py-3.5">
                      <div className="font-semibold text-gray-900 truncate max-w-[280px]">
                        {c.name}
                      </div>
                      <div className="relative h-1 mt-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-teal-500"
                          style={{ width: `${share}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3.5">{providerChip(c.provider)}</td>
                    <td className="px-3 py-3.5 text-right text-xs text-gray-500 tabular-nums">
                      {fmtDate(c.startedAt)}
                    </td>
                    <td className="px-3 py-3.5 text-right tabular-nums">
                      <span className="font-medium text-gray-900">
                        {c.callsMade.toLocaleString("en-IN")}
                      </span>
                      <span className="text-[10px] text-gray-400 ml-1">
                        / {c.totalLeads.toLocaleString("en-IN")}
                      </span>
                    </td>
                    <td className="px-3 py-3.5 text-right text-sm text-gray-700 tabular-nums">
                      {formatINRDetailed(c.avgCostPerCallCents)}
                    </td>
                    <td className="px-3 py-3.5 text-right pr-6">
                      <div className="font-bold text-gray-900 tabular-nums">
                        {formatINR(c.totalCostCents)}
                      </div>
                      <div className="text-[10px] text-gray-400 tabular-nums">
                        {share.toFixed(1)}% share
                      </div>
                    </td>
                    <td className="pr-4">
                      <ChevronRight
                        className={`w-4 h-4 transition-all ${
                          isSelected
                            ? "text-emerald-600 translate-x-0.5"
                            : "text-gray-300"
                        }`}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {campaigns.length > 0 && (
        <div className="px-6 py-2.5 border-t border-gray-100 flex items-center justify-between text-[11px] text-gray-500 bg-gray-50/40">
          <span>
            Showing{" "}
            <span className="font-semibold text-gray-700 tabular-nums">
              {campaigns.length}
            </span>{" "}
            campaign{campaigns.length === 1 ? "" : "s"} — click a row to
            drill into per-call costs
          </span>
          <span className="tabular-nums">
            <span className="font-bold text-gray-900">
              {formatINR(grandTotal)}
            </span>{" "}
            combined
          </span>
        </div>
      )}
    </div>
  );
}
