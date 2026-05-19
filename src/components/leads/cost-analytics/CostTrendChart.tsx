// Daily spend trend — the financial through-line of the dashboard. Uses
// a layered area chart so the eye reads spend as a continuous narrative,
// with crisp value/date affordances on hover.
//
// Renders nothing until mounted (recharts SSR mismatch otherwise). Empty
// state is a thoughtful "no spend yet" so users don't see a flat line.

"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { formatINR, usdCentsToInr } from "@/lib/currency";
import type { TrendPoint } from "./types";

const ACCENT = "#0d9488"; // brand teal

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  const inrValue = Number(point.value ?? 0);
  const calls = (point.payload as { calls: number } | undefined)?.calls ?? 0;
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg px-3 py-2.5 text-xs">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">
        {label && new Date(label).toLocaleDateString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })}
      </p>
      <p className="font-bold text-gray-900 tabular-nums">
        ₹
        {Math.round(inrValue).toLocaleString("en-IN")}
      </p>
      <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
        {calls} {calls === 1 ? "call" : "calls"}
      </p>
    </div>
  );
}

type CostTrendChartProps = {
  data: TrendPoint[];
  loading?: boolean;
};

export function CostTrendChart({ data, loading }: CostTrendChartProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const chartData = data.map((d) => ({
    date: d.date,
    label: shortDate(d.date),
    inr: usdCentsToInr(d.costCents),
    calls: d.calls,
  }));

  const totalCostCents = data.reduce((s, p) => s + p.costCents, 0);
  const peakDay = chartData.reduce<typeof chartData[number] | null>((max, p) => {
    if (!max || p.inr > max.inr) return p;
    return max;
  }, null);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between px-6 pt-5 pb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
              Daily spend
            </span>
          </div>
          <h3 className="text-base font-bold text-gray-900 tracking-tight">
            Cost over time
          </h3>
        </div>
        {peakDay && (
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">
              Peak
            </p>
            <p className="text-sm font-bold text-gray-900 tabular-nums">
              ₹{Math.round(peakDay.inr).toLocaleString("en-IN")}
            </p>
            <p className="text-[10px] text-gray-400 tabular-nums">
              {peakDay.label}
            </p>
          </div>
        )}
      </div>

      <div className="h-72 px-2 pb-4">
        {!mounted || loading ? (
          <div className="h-full w-full flex items-center justify-center">
            <div className="text-sm text-gray-400">
              {loading ? "Loading…" : ""}
            </div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-10 h-10 rounded-2xl bg-gray-50 flex items-center justify-center mb-2">
              <TrendingUp className="w-4 h-4 text-gray-300" />
            </div>
            <p className="text-sm font-medium text-gray-700">
              No spend in this window
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              Adjust the date range or filters to see costs.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 24, left: 8, bottom: 4 }}
            >
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 4"
                vertical={false}
                stroke="#eef2f7"
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                dy={6}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={(v: number) =>
                  v >= 100000
                    ? `₹${(v / 100000).toFixed(1)}L`
                    : v >= 1000
                      ? `₹${(v / 1000).toFixed(0)}k`
                      : `₹${v}`
                }
                width={56}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#cbd5e1", strokeWidth: 1, strokeDasharray: "4 4" }} />
              <Area
                type="monotone"
                dataKey="inr"
                stroke={ACCENT}
                strokeWidth={2}
                fill="url(#trendFill)"
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff", fill: ACCENT }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {chartData.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-3 text-xs">
          <span className="text-gray-500">
            <span className="tabular-nums font-semibold text-gray-700">
              {chartData.length}
            </span>{" "}
            day{chartData.length === 1 ? "" : "s"} of activity
          </span>
          <span className="text-gray-500">
            Period total:{" "}
            <span className="font-semibold text-gray-900 tabular-nums">
              {formatINR(totalCostCents)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
