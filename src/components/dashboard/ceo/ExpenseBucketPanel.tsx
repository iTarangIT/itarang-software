"use client";

/**
 * E-218 / E-219 — the header of the CEO Expenses drill-down.
 *
 * E-218 put four clickable bucket tiles, a six-month stacked bar chart and a
 * department strip above the invoice list. E-219 replaced the tiles and the
 * chart with a filter row:
 *
 *   filters — department, bucket, month and an explicit date range, each option
 *             labelled with how many invoices it would leave in the list
 *   strip   — the window by department, i.e. whose budget it came out of
 *
 * WHY THE TILES BECAME A DROPDOWN
 *   Four tiles could only ever show four buckets, and only ever filter by
 *   bucket. A dropdown carries the same filter in a fraction of the height and
 *   leaves room for the department, month and range filters beside it — which
 *   is what the drill-down was actually being used to do.
 *
 * WHY THE CHART WENT
 *   It compared a fixed trailing six months, which is not a question the list
 *   below it could answer. Picking a month or a range now changes the list, the
 *   total and the strip together.
 *
 * The filters are lifted into DrillDownModal rather than held here, because the
 * invoice list has to be filtered by the SAME values — server-side, since it is
 * capped at 500 rows and a client-side filter of a truncated page would show a
 * subset while the count beside the dropdown stated the true one.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { MonthCalendar } from "./MonthCalendar";

interface BucketRow {
  bucket: string;
  label: string;
  total: number;
  count: number;
  share: number;
}

interface DepartmentRow {
  department: string;
  label: string;
  total: number;
  count: number;
}

interface BucketsResponse {
  period: string;
  label: string;
  total: number;
  count: number;
  buckets: BucketRow[];
  departments: DepartmentRow[];
}

export interface ExpenseFilters {
  department: string | null;
  bucket: string | null;
  /** "YYYY-MM", or null when the window is not a single month. */
  month: string | null;
  from: string;
  to: string;
}

export const EMPTY_EXPENSE_FILTERS: ExpenseFilters = {
  department: null,
  bucket: null,
  month: null,
  from: "",
  to: "",
};

interface Props {
  /** Window query string for the breakdown, e.g. "period=mtd" or "month=2026-06". */
  params?: string;
  filters: ExpenseFilters;
  onFiltersChange: (next: ExpenseFilters) => void;
}

export function ExpenseBucketPanel({
  params = "period=mtd",
  filters,
  onFiltersChange,
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

  // Hide a bucket with nothing in it — "Unclassified" should vanish once the
  // backfill has run rather than sit in the dropdown as a permanent zero.
  const buckets = React.useMemo(
    () => (data?.buckets ?? []).filter((b) => b.count > 0),
    [data],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 border-b border-gray-100">
        <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
      </div>
    );
  }
  // A failure here must not hide the list underneath — the breakdown is an
  // extra read on top of the rows, not a precondition for them. The filters go
  // with it: they are labelled from this payload, and a dropdown with no counts
  // would be worse than none.
  if (isError || !data) return null;

  return (
    <div className="space-y-4 pb-5 border-b border-gray-100">
      <ExpenseFilterRow
        filters={filters}
        onChange={onFiltersChange}
        departments={data.departments}
        buckets={buckets}
        totalCount={data.count}
      />

      <DepartmentStrip
        departments={data.departments}
        total={data.total}
        selected={filters.department}
        onSelect={(department) =>
          onFiltersChange({
            ...filters,
            department: filters.department === department ? null : department,
          })
        }
      />
    </div>
  );
}

/** Every control that narrows the list, on one row. */
function ExpenseFilterRow({
  filters,
  onChange,
  departments,
  buckets,
  totalCount,
}: {
  filters: ExpenseFilters;
  onChange: (next: ExpenseFilters) => void;
  departments: DepartmentRow[];
  buckets: BucketRow[];
  totalCount: number;
}) {
  const [monthOpen, setMonthOpen] = React.useState(false);
  const rangeActive = Boolean(filters.from || filters.to);
  const anyActive =
    Boolean(filters.department) ||
    Boolean(filters.bucket) ||
    Boolean(filters.month) ||
    rangeActive;

  return (
    <div className="flex items-end gap-2 flex-wrap">
      <Field label="Department">
        <select
          value={filters.department ?? ""}
          onChange={(e) => onChange({ ...filters, department: e.target.value || null })}
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 outline-none focus:border-brand-300 min-w-[170px]"
        >
          <option value="">All departments ({totalCount})</option>
          {departments.map((d) => (
            <option key={d.department} value={d.department}>
              {d.label} ({d.count})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Bucket">
        <select
          value={filters.bucket ?? ""}
          onChange={(e) => onChange({ ...filters, bucket: e.target.value || null })}
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 outline-none focus:border-brand-300 min-w-[150px]"
        >
          <option value="">All buckets ({totalCount})</option>
          {buckets.map((b) => (
            <option key={b.bucket} value={b.bucket}>
              {b.label} ({b.count})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Month">
        <div className="relative">
          <button
            type="button"
            onClick={() => setMonthOpen((o) => !o)}
            aria-expanded={monthOpen}
            className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors ${
              filters.month
                ? "border-brand-200 bg-brand-50 text-brand-800"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            }`}
          >
            {filters.month ? monthLabel(filters.month) : "Any month"}
          </button>
          {monthOpen && (
            <>
              {/* Click-away layer — the picker is a popover, and leaving it open
                  while the list changes underneath reads as a stuck menu. */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMonthOpen(false)}
                aria-hidden
              />
              <div className="absolute z-20 mt-1 p-3 rounded-xl border border-gray-100 bg-white shadow-lg">
                <MonthCalendar
                  value={filters.month}
                  onSelect={(value) => {
                    // A month and an explicit range are two ways to say the
                    // same thing, so picking one clears the other rather than
                    // leaving both lit with only one of them in effect.
                    onChange({ ...filters, month: value, from: "", to: "" });
                    setMonthOpen(false);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </Field>

      <Field label="Date range">
        <div
          className={`inline-flex items-center gap-1 rounded-lg border bg-white px-2 h-8 ${
            rangeActive ? "border-brand-200 ring-1 ring-brand-100" : "border-gray-200"
          }`}
        >
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) =>
              onChange({ ...filters, from: e.target.value, month: null })
            }
            aria-label="From date"
            className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
          />
          <span className="text-gray-300">–</span>
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) =>
              onChange({ ...filters, to: e.target.value, month: null })
            }
            aria-label="To date"
            className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
          />
        </div>
      </Field>

      {anyActive && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_EXPENSE_FILTERS })}
          className="h-8 inline-flex items-center gap-1 px-2.5 rounded-lg text-xs font-semibold text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="w-3.5 h-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });

/**
 * Whose budget the window came out of — E-106's department, one bar each.
 * Each bar is also a shortcut for the Department dropdown above: the bars are
 * where you notice a department, so they are where you would try to click.
 */
function DepartmentStrip({
  departments,
  total,
  selected,
  onSelect,
}: {
  departments: DepartmentRow[];
  total: number;
  selected: string | null;
  onSelect: (department: string) => void;
}) {
  if (departments.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2">
        By department
      </p>
      <ul className="space-y-1.5">
        {departments.map((d) => {
          const active = selected === d.department;
          return (
            <li key={d.department}>
              <button
                type="button"
                onClick={() => onSelect(d.department)}
                aria-pressed={active}
                className={`w-full flex items-center gap-3 rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-gray-50 ${
                  selected && !active ? "opacity-50" : ""
                }`}
              >
                <span
                  className={`text-[11px] w-24 shrink-0 truncate text-left ${
                    active ? "font-bold text-brand-700" : "font-medium text-gray-600"
                  }`}
                >
                  {d.label}
                </span>
                <span className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <span
                    className={`block h-full rounded-full ${
                      active ? "bg-brand-600" : "bg-brand-500"
                    }`}
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
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
