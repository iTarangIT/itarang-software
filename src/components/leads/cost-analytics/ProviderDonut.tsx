// Provider split — Bolna vs ElevenLabs cost share. The center value is
// the bigger story (total spend), the segments answer "which provider
// drove that spend". Donut is more readable than a pie for two-segment
// data — center can carry the headline metric.

"use client";

import * as React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Cpu } from "lucide-react";
import { formatINR } from "@/lib/currency";
import type { ProviderSplit } from "./types";

const PROVIDER_META: Record<
  string,
  { label: string; color: string; swatch: string }
> = {
  bolna: { label: "Bolna", color: "#3b82f6", swatch: "bg-blue-500" },
  elevenlabs: { label: "ElevenLabs", color: "#8b5cf6", swatch: "bg-violet-500" },
};

type ProviderDonutProps = {
  data: ProviderSplit[];
  loading?: boolean;
};

export function ProviderDonut({ data, loading }: ProviderDonutProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const total = data.reduce((s, d) => s + d.costCents, 0);
  const chartData = data.map((d) => ({
    name: PROVIDER_META[d.provider]?.label ?? d.provider,
    value: d.costCents,
    color: PROVIDER_META[d.provider]?.color ?? "#94a3b8",
    calls: d.calls,
  }));

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-6">
      <div className="flex items-center gap-2 mb-1">
        <Cpu className="w-3.5 h-3.5 text-gray-400" />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
          Provider split
        </span>
      </div>
      <h3 className="text-base font-bold text-gray-900 tracking-tight mb-5">
        Bolna vs ElevenLabs
      </h3>

      <div className="relative h-44">
        {mounted && !loading && total > 0 ? (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  innerRadius={56}
                  outerRadius={82}
                  paddingAngle={2}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                  stroke="#fff"
                  strokeWidth={2}
                >
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0];
                    const pct =
                      total > 0
                        ? ((Number(p.value ?? 0) / total) * 100).toFixed(1)
                        : "0";
                    const calls = (p.payload as { calls?: number })?.calls ?? 0;
                    return (
                      <div className="bg-white border border-gray-200 rounded-xl shadow-lg px-3 py-2 text-xs">
                        <p className="font-bold text-gray-900">{p.name}</p>
                        <p className="text-gray-500 tabular-nums">
                          {formatINR(Number(p.value ?? 0))} · {pct}%
                        </p>
                        <p className="text-[11px] text-gray-400 tabular-nums">
                          {calls} calls
                        </p>
                      </div>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">
                Total
              </span>
              <span className="text-xl font-bold text-gray-900 tracking-tight tabular-nums">
                {formatINR(total)}
              </span>
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            {loading ? "Loading…" : "No spend yet"}
          </div>
        )}
      </div>

      <ul className="mt-5 space-y-2">
        {chartData.length === 0 ? (
          <li className="text-xs text-gray-400">No calls in this window.</li>
        ) : (
          chartData.map((d, i) => {
            const meta =
              Object.values(PROVIDER_META).find((m) => m.color === d.color) ??
              { swatch: "bg-gray-300" };
            const pct = total > 0 ? (d.value / total) * 100 : 0;
            return (
              <li
                key={i}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`w-2.5 h-2.5 rounded-full ${meta.swatch}`} />
                  <span className="text-gray-700">{d.name}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums">
                    {d.calls} calls
                  </span>
                </div>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="text-[11px] text-gray-400 w-12 text-right">
                    {pct.toFixed(1)}%
                  </span>
                  <span className="font-semibold text-gray-900 w-20 text-right">
                    {formatINR(d.value)}
                  </span>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
