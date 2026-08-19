"use client";

/**
 * The Expense Ledger's filter row: search, date range, department, bucket,
 * project and vendor.
 *
 * It lives in its own file because both views share it — the filters apply to
 * the summary and to the flat list identically, and duplicating six controls
 * across two tables is how they drift apart.
 *
 * Project and vendor options are supplied by the caller rather than derived
 * here. They come from the server, scoped to the same window and the same other
 * filters, so an option can never be offered that would return nothing.
 */

import React from "react";
import { Search, X } from "lucide-react";
import {
  EXPENSE_BUCKETS,
  EXPENSE_DEPARTMENTS,
  UNASSIGNED_DEPARTMENT_KEY,
  UNCLASSIFIED_BUCKET_KEY,
} from "@/lib/expenses";
import {
  EMPTY_LEDGER_FILTERS,
  hasActiveLedgerFilter,
  hasDateOverride,
  type LedgerFilterState,
} from "./types";

const selectCls =
  "h-8 px-2.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-700 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-50 disabled:cursor-not-allowed";

interface Props {
  value: LedgerFilterState;
  onChange: (next: LedgerFilterState) => void;
  projectOptions: string[];
  vendorOptions: string[];
}

export function LedgerFilters({
  value,
  onChange,
  projectOptions,
  vendorOptions,
}: Props) {
  /**
   * Two pieces of state for one box: `text` is what the input shows and updates
   * on every keystroke, `value.search` is what the server is asked for and must
   * not. Without the split, every character typed is a round trip and a
   * re-render of both tables.
   */
  const [text, setText] = React.useState(value.search);

  React.useEffect(() => {
    const t = setTimeout(() => {
      if (text !== value.search) onChange({ ...value, search: text });
    }, 300);
    return () => clearTimeout(t);
    // `value` is deliberately not a dependency: including it restarts the timer
    // on every unrelated filter change, so a pending search would never land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Resync when search is changed from outside — Clear, most importantly.
  // Converges in one pass because the debounce only fires when the two differ.
  React.useEffect(() => {
    setText(value.search);
  }, [value.search]);

  /**
   * Changing department clears project and vendor.
   *
   * Both are scoped to the selected department server-side, so keeping a
   * project from the department you just left would ask for an intersection
   * that is empty by construction — an empty table with nothing on screen
   * explaining why. Search is deliberately NOT cleared: typed text is work, and
   * wiping it because another control moved is what makes people stop using it.
   */
  const setDepartment = (department: string) =>
    onChange({ ...value, department, project: "all", vendor: "all" });

  const clearAll = () => {
    setText("");
    onChange({ ...EMPTY_LEDGER_FILTERS });
  };

  const dateActive = hasDateOverride(value);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search vendor, invoice, project…"
          aria-label="Search expenses"
          className="h-8 w-[220px] pl-8 pr-2.5 rounded-lg border border-gray-200 text-xs text-gray-700 bg-white placeholder:text-gray-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      {/* Overrides the dashboard's period bar rather than narrowing it — see
          LedgerFilterState.from. The ring makes the override visible, because
          a card quietly showing a different span than the bar above it is the
          thing most likely to be misread. */}
      <div
        className={`inline-flex items-center gap-1 rounded-lg border bg-white px-2 h-8 ${
          dateActive
            ? "border-brand-200 ring-1 ring-brand-100"
            : "border-gray-200"
        }`}
      >
        <input
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          aria-label="From date"
          className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
        />
        <span className="text-gray-300">–</span>
        <input
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          aria-label="To date"
          className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
        />
      </div>

      <select
        aria-label="Filter by department"
        className={selectCls}
        value={value.department}
        onChange={(e) => setDepartment(e.target.value)}
      >
        <option value="all">All departments</option>
        {EXPENSE_DEPARTMENTS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
        <option value={UNASSIGNED_DEPARTMENT_KEY}>Unassigned</option>
      </select>

      <select
        aria-label="Filter by bucket"
        className={selectCls}
        value={value.bucket}
        onChange={(e) => onChange({ ...value, bucket: e.target.value })}
      >
        <option value="all">All buckets</option>
        {EXPENSE_BUCKETS.map((b) => (
          <option key={b.value} value={b.value}>
            {b.label}
          </option>
        ))}
        <option value={UNCLASSIFIED_BUCKET_KEY}>Unclassified</option>
      </select>

      <select
        aria-label="Filter by project"
        className={selectCls}
        value={value.project}
        onChange={(e) => onChange({ ...value, project: e.target.value })}
        disabled={projectOptions.length === 0}
      >
        <option value="all">All projects</option>
        {projectOptions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by vendor"
        className={selectCls}
        value={value.vendor}
        onChange={(e) => onChange({ ...value, vendor: e.target.value })}
        disabled={vendorOptions.length === 0}
      >
        <option value="all">All vendors</option>
        {vendorOptions.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>

      {hasActiveLedgerFilter(value) && (
        <button
          type="button"
          onClick={clearAll}
          className="h-8 inline-flex items-center gap-1 px-2.5 rounded-lg text-xs font-semibold text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="w-3.5 h-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}
