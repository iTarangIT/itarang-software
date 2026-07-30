"use client";

/**
 * E-219 — the one window control for the CEO landing page.
 *
 * Every headline figure on that page — the four cards, the Realization
 * drill-down and the revenue/expense chart — reads this single piece of state.
 * Per-card period toggles were the alternative, and they let two cards sit side
 * by side showing different months with nothing on screen saying so.
 */

import React from "react";
import { CalendarRange, X } from "lucide-react";

export type CeoPeriod = "mtd" | "ytd" | "fy" | "inception" | "range";

export interface CeoWindow {
  period: CeoPeriod;
  /** Only meaningful when period is "range". Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
}

export const DEFAULT_CEO_WINDOW: CeoWindow = {
  period: "mtd",
  from: "",
  to: "",
};

const PRESETS: { value: CeoPeriod; label: string }[] = [
  { value: "mtd", label: "MTD" },
  { value: "ytd", label: "YTD" },
  { value: "fy", label: "FY" },
  { value: "inception", label: "Inception" },
];

/**
 * The window as a query string, shared by every request the page makes so the
 * cards and the chart cannot end up describing different spans.
 *
 * A "range" with neither end filled falls back to `period=range`, which the
 * resolver reads as month-to-date — the same thing the bar shows before any
 * date is picked.
 */
export function ceoWindowParams(w: CeoWindow): URLSearchParams {
  const sp = new URLSearchParams({ period: w.period });
  if (w.period === "range") {
    if (w.from) sp.set("from", w.from);
    if (w.to) sp.set("to", w.to);
  }
  return sp;
}

export function CeoFilterBar({
  value,
  onChange,
}: {
  value: CeoWindow;
  onChange: (w: CeoWindow) => void;
}) {
  const rangeActive = value.period === "range";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={value.period === p.value}
            onClick={() => onChange({ ...value, period: p.value })}
            className={`px-3 h-7 text-xs font-semibold rounded-md transition-colors ${
              value.period === p.value
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div
        className={`inline-flex items-center gap-1 rounded-lg border bg-white px-2 h-8 ${
          rangeActive ? "border-brand-200 ring-1 ring-brand-100" : "border-gray-200"
        }`}
      >
        <CalendarRange className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <input
          type="date"
          value={value.from}
          max={value.to || undefined}
          // Picking a date IS choosing the range period — leaving the preset
          // selected would show a highlighted "FY" above figures the dates say
          // are something else.
          onChange={(e) => onChange({ ...value, period: "range", from: e.target.value })}
          aria-label="From date"
          className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
        />
        <span className="text-gray-300">–</span>
        <input
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ ...value, period: "range", to: e.target.value })}
          aria-label="To date"
          className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
        />
        {(value.from || value.to) && (
          <button
            type="button"
            aria-label="Clear date range"
            onClick={() => onChange({ period: "mtd", from: "", to: "" })}
            className="ml-0.5 grid place-items-center h-5 w-5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
