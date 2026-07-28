"use client";

/**
 * E-218 — the header of the CEO Expenses drill-down.
 *
 * That drill-down used to be a flat list of every approved invoice with a
 * single total on top: it answered "how much" and nothing else. This sits
 * above the list and answers the two questions the total raises, off one
 * fetch:
 *
 *   tiles — the window split four ways, each one a filter for the list below
 *   bars  — the same split for the trailing six months, so this month can be
 *           read against the ones before it
 *   strip — the same window by department, i.e. whose budget it came out of
 *
 * It takes the drill-down's own window params, so the tiles always sum to the
 * total beside them. Colours come from expenseBucketColor(), which the ledger
 * and the admin tracker also use — nothing here can disagree with those.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { expenseBucketColor } from "@/lib/expenses";

interface BucketRow {
  bucket: string;
  label: string;
  total: number;
  share: number;
}

interface TrendSeries {
  bucket: string;
  label: string;
  totals: number[];
}

interface DepartmentRow {
  department: string;
  label: string;
  total: number;
}

interface BucketsResponse {
  period: string;
  label: string;
  total: number;
  buckets: BucketRow[];
  departments: DepartmentRow[];
  trend: {
    months: string[];
    monthLabels: string[];
    series: TrendSeries[];
  };
}

interface Props {
  /** Window query string for the drill-down, e.g. "period=mtd" or "month=2026-06". */
  params?: string;
  /** The bucket currently filtering the list below, or null for all of them. */
  selected?: string | null;
  /** Toggles that filter. */
  onSelect?: (bucket: string | null) => void;
}

export function ExpenseBucketPanel({
  params = "period=mtd",
  selected = null,
  onSelect,
}: Props) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ceo-expense-buckets", params],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/expenses-buckets?${params}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load bucket breakdown");
      const j = await r.json();
      return j.data as BucketsResponse;
    },
  });

  // Hide a bucket that is empty in BOTH the window and every trend month —
  // "Unclassified" should vanish once the backfill has run rather than sit
  // there as a permanent zero row.
  const visible = React.useMemo(() => {
    if (!data) return [];
    const inTrend = new Map(
      data.trend.series.map((s) => [s.bucket, s.totals.reduce((a, b) => a + b, 0)]),
    );
    return data.buckets.filter(
      (b) => b.total > 0 || (inTrend.get(b.bucket) ?? 0) > 0,
    );
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 border-b border-gray-100">
        <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
      </div>
    );
  }
  // A failure here must not hide the list underneath — the breakdown is an
  // extra read on top of the rows, not a precondition for them.
  if (isError || !data || data.total === 0) return null;

  return (
    <div className="space-y-5 pb-5 border-b border-gray-100">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {visible.map((b) => (
          <BucketTile
            key={b.bucket}
            row={b}
            active={selected === b.bucket}
            dimmed={selected !== null && selected !== b.bucket}
            onClick={
              onSelect
                ? () => onSelect(selected === b.bucket ? null : b.bucket)
                : undefined
            }
          />
        ))}
      </div>

      <TrendChart trend={data.trend} visible={visible.map((b) => b.bucket)} />

      <DepartmentStrip departments={data.departments} total={data.total} />
    </div>
  );
}

function BucketTile({
  row,
  active,
  dimmed,
  onClick,
}: {
  row: BucketRow;
  active: boolean;
  dimmed: boolean;
  onClick?: () => void;
}) {
  const color = expenseBucketColor(row.bucket);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || row.total === 0}
      aria-pressed={active}
      className={`text-left p-3 rounded-xl border transition-all enabled:hover:border-brand-200 disabled:cursor-default ${
        active
          ? "border-brand-300 bg-white ring-2 ring-brand-100"
          : "border-gray-100 bg-gray-50/60 enabled:hover:bg-white"
      } ${dimmed ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-[11px] font-semibold text-gray-600 truncate">
          {row.label}
        </span>
      </div>
      <p
        className="text-lg font-bold text-gray-900 tracking-tight"
        title={formatINRExact(row.total)}
      >
        {formatINRCompact(row.total)}
      </p>
      <p className="text-[10px] font-medium text-gray-400 mt-0.5">
        {(row.share * 100).toFixed(row.share >= 0.1 ? 0 : 1)}% of spend
      </p>
    </button>
  );
}

/** Whose budget the window came out of — E-106's department, one bar each. */
function DepartmentStrip({
  departments,
  total,
}: {
  departments: DepartmentRow[];
  total: number;
}) {
  if (departments.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2">
        By department
      </p>
      <ul className="space-y-1.5">
        {departments.map((d) => (
          <li key={d.department} className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-gray-600 w-24 shrink-0 truncate">
              {d.label}
            </span>
            <span className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <span
                className="block h-full rounded-full bg-brand-500"
                style={{
                  width: `${Math.max(total > 0 ? (d.total / total) * 100 : 0, 2)}%`,
                }}
              />
            </span>
            <span
              className="text-[11px] font-bold text-gray-800 tabular-nums shrink-0"
              title={formatINRExact(d.total)}
            >
              {formatINRCompact(d.total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Stacked bars, one per month, drawn with plain divs — six bars and four
 * segments does not justify pulling a charting library into the CEO bundle.
 *
 * Every bar is scaled against the tallest month, so heights are comparable
 * across the row; that is the only thing this chart has to get right.
 */
function TrendChart({
  trend,
  visible,
}: {
  trend: BucketsResponse["trend"];
  visible: string[];
}) {
  const series = trend.series.filter((s) => visible.includes(s.bucket));
  const monthTotals = trend.months.map((_, i) =>
    series.reduce((sum, s) => sum + (s.totals[i] ?? 0), 0),
  );
  const peak = Math.max(...monthTotals, 0);

  if (peak === 0) {
    return (
      <p className="text-[11px] text-gray-400 italic">
        No spend in the last {trend.months.length} months to compare.
      </p>
    );
  }

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-3">
        Last {trend.months.length} months
      </p>

      <div className="flex items-end justify-between gap-2 h-36">
        {trend.months.map((month, i) => {
          const monthTotal = monthTotals[i];
          // Scale the whole bar, then split it by each segment's share of that
          // month — so a segment's height reads as its share and the bar's
          // height reads as the month's total.
          const barPct = peak > 0 ? (monthTotal / peak) * 100 : 0;
          return (
            <div key={month} className="flex-1 flex flex-col items-center gap-1.5 h-full">
              <div className="flex-1 w-full flex flex-col justify-end">
                <div
                  className="w-full rounded-t-md overflow-hidden flex flex-col-reverse min-h-[2px]"
                  style={{ height: `${Math.max(barPct, monthTotal > 0 ? 2 : 0)}%` }}
                  title={`${trend.monthLabels[i]} · ${formatINRExact(monthTotal)}`}
                >
                  {series.map((s) => {
                    const value = s.totals[i] ?? 0;
                    if (value <= 0) return null;
                    return (
                      <div
                        key={s.bucket}
                        style={{
                          height: `${(value / monthTotal) * 100}%`,
                          backgroundColor: expenseBucketColor(s.bucket),
                        }}
                        title={`${s.label} · ${formatINRExact(value)}`}
                      />
                    );
                  })}
                </div>
              </div>
              <span className="text-[10px] font-medium text-gray-400">
                {trend.monthLabels[i]}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-4 pt-3 border-t border-gray-50">
        {series.map((s) => (
          <span key={s.bucket} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-sm shrink-0"
              style={{ backgroundColor: expenseBucketColor(s.bucket) }}
            />
            <span className="text-[10px] font-medium text-gray-500">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
