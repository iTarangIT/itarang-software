// Hero KPI row for the Cost Analytics dashboard. Total Spend is given
// outsized treatment — wider span, accent-bordered card, larger numeral —
// because "what did we spend" is the only question that matters at first
// glance. The secondary KPIs (avg/call, avg/min, total calls) sit in a
// tighter rhythm to the right.

"use client";

import { Wallet, PhoneCall, Clock, TrendingDown, AlertCircle } from "lucide-react";
import { formatINR, formatINRDetailed, getUsdToInrRate } from "@/lib/currency";
import type { SummaryKPI } from "./types";

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0m";
  const minutes = Math.round(secs / 60);
  if (minutes < 60) return `${minutes.toLocaleString("en-IN")}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem
    ? `${hours.toLocaleString("en-IN")}h ${rem}m`
    : `${hours.toLocaleString("en-IN")}h`;
}

type KPIRowProps = {
  summary: SummaryKPI;
  loading?: boolean;
};

export function KPIRow({ summary, loading }: KPIRowProps) {
  const coveragePct =
    summary.coverage.total > 0
      ? Math.round((summary.coverage.withCost / summary.coverage.total) * 100)
      : 100;
  const missing = summary.coverage.total - summary.coverage.withCost;
  const rate = getUsdToInrRate();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-6 gap-3">
      {/* Total Spend — hero card spans 3 cols on lg */}
      <div className="lg:col-span-3 relative overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-white via-white to-emerald-50/40 p-6 shadow-sm">
        <div className="absolute top-0 right-0 w-32 h-32 -translate-y-8 translate-x-8 rounded-full bg-emerald-100/40 blur-3xl pointer-events-none" />
        <div className="relative">
          <div className="flex items-start justify-between mb-4">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700">
                Total spend
              </span>
              <p className="text-xs text-gray-500 mt-1">
                Across all selected calls
              </p>
            </div>
            <div className="p-2.5 bg-emerald-100/60 rounded-xl">
              <Wallet className="w-4 h-4 text-emerald-700" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl lg:text-5xl font-bold tracking-tight text-gray-900 tabular-nums">
              {loading ? (
                <span className="inline-block w-32 h-10 bg-gray-100 rounded animate-pulse" />
              ) : (
                formatINR(summary.totalCostCents)
              )}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-gray-400">
            USD→INR @ {rate} · ${(summary.totalCostCents / 100).toFixed(2)}
          </p>
          {missing > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              <AlertCircle className="w-3 h-3" />
              <span className="font-medium tabular-nums">
                {missing} of {summary.coverage.total}
              </span>
              <span>calls awaiting cost capture · {coveragePct}% coverage</span>
            </div>
          )}
        </div>
      </div>

      {/* Avg / Call */}
      <SecondaryKPI
        eyebrow="Avg / Call"
        value={loading ? "—" : formatINRDetailed(summary.avgCostPerCallCents)}
        icon={PhoneCall}
        accent="text-blue-700 bg-blue-50"
        sub={
          summary.coverage.withCost > 0
            ? `${summary.coverage.withCost.toLocaleString("en-IN")} priced calls`
            : "—"
        }
      />

      {/* Avg / Minute */}
      <SecondaryKPI
        eyebrow="Avg / Minute"
        value={
          loading ? "—" : formatINRDetailed(summary.avgCostPerMinuteCents)
        }
        icon={Clock}
        accent="text-indigo-700 bg-indigo-50"
        sub={formatDuration(summary.totalDurationSecs) + " total"}
      />

      {/* Total Calls */}
      <SecondaryKPI
        eyebrow="Calls"
        value={
          loading ? "—" : summary.totalCalls.toLocaleString("en-IN")
        }
        icon={TrendingDown}
        accent="text-slate-700 bg-slate-100"
        sub={`${coveragePct}% with cost`}
      />
    </div>
  );
}

function SecondaryKPI({
  eyebrow,
  value,
  icon: Icon,
  accent,
  sub,
}: {
  eyebrow: string;
  value: string;
  icon: typeof Wallet;
  accent: string;
  sub: string;
}) {
  return (
    <div className="lg:col-span-1 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm hover:border-gray-300 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
          {eyebrow}
        </span>
        <div className={`p-1.5 rounded-lg ${accent}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="text-2xl font-bold tracking-tight text-gray-900 tabular-nums">
        {value}
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400 truncate">{sub}</p>
    </div>
  );
}
