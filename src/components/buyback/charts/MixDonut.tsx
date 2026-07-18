"use client";

/**
 * Battery-mix donut for the admin buyback dashboard — a recharts PieChart with a
 * hollow centre carrying the total (e.g. "55 units") and a per-slice legend down
 * the side. Used for both the chemistry and brand cuts (parent picks the data).
 *
 * Pure presentational: recharts imported directly (this is the lazy chunk), no
 * buyback lib imports. Zero-unit slices are filtered out; empty data renders
 * nothing (the parent owns the empty state).
 */

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

export interface MixDatum {
  key: string;
  units: number;
}

// Navy / green / amber / slate anchored categorical set, cycled for extra slices.
const PALETTE = ["#0B2239", "#16A34A", "#F59E0B", "#64748B", "#0EA5E9", "#94A3B8"];

export default function MixDonut({
  data,
  centerLabel,
  height = 260,
}: {
  data: MixDatum[];
  centerLabel: string;
  height?: number;
}) {
  const slices = (data ?? []).filter((d) => Number(d.units) > 0);
  if (slices.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="units"
              nameKey="key"
              innerRadius={55}
              outerRadius={85}
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-[15px] font-extrabold tabular-nums text-slate-900">{centerLabel}</div>
        </div>
      </div>

      <ul className="flex-1 space-y-1.5 text-[12.5px]">
        {slices.map((s, i) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-slate-600">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: PALETTE[i % PALETTE.length] }}
              />
              {s.key}
            </span>
            <span className="font-semibold tabular-nums text-slate-900">{s.units}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
