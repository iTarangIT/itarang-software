"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const pad2 = (n: number) => String(n).padStart(2, "0");

interface MonthCalendarProps {
  /** Currently selected month as "YYYY-MM", or null when no month is picked. */
  value: string | null;
  /** Called with the "YYYY-MM" value when the user picks a month. */
  onSelect: (value: string) => void;
  /** How many years back the ‹ arrow can navigate. Default 5. */
  yearsBack?: number;
  /** Caption above the grid. Default "Pick a month". */
  label?: string;
  /**
   * When provided, the year label becomes a clickable button that selects the
   * whole calendar year (total of all its months).
   */
  onSelectYear?: (year: number) => void;
  /** The selected full year — highlights the year label when it matches. */
  selectedYear?: number | null;
}

/**
 * Compact month picker: a ‹ year › navigator over a 3×4 grid of months.
 * Future months are disabled; the current month is ringed; the selected month
 * is filled. Styled with the shared brand tokens so it matches the dashboard.
 */
export function MonthCalendar({
  value,
  onSelect,
  yearsBack = 5,
  label = "Pick a month",
  onSelectYear,
  selectedYear = null,
}: MonthCalendarProps) {
  const { curYear, curMonth } = useMemo(() => {
    const n = new Date();
    return { curYear: n.getFullYear(), curMonth: n.getMonth() };
  }, []);

  // Show the year of whatever is active (a picked month, a picked full year),
  // falling back to the current year.
  const activeYear = value ? Number(value.slice(0, 4)) : selectedYear ?? curYear;
  const [viewYear, setViewYear] = useState(activeYear);
  useEffect(() => {
    setViewYear(activeYear);
  }, [activeYear]);

  const yearSelected = selectedYear === viewYear;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
          {label}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous year"
            disabled={viewYear <= curYear - yearsBack}
            onClick={() => setViewYear((y) => y - 1)}
            className="p-1 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          {onSelectYear ? (
            <button
              type="button"
              data-testid="month-calendar-year"
              onClick={() => onSelectYear(viewYear)}
              title="Show the whole year's total"
              className={cn(
                "text-sm font-bold tabular-nums w-11 text-center rounded-md py-0.5 transition-colors",
                yearSelected
                  ? "bg-brand-600 text-white shadow-sm"
                  : "text-gray-800 hover:bg-gray-100 hover:text-brand-700",
              )}
            >
              {viewYear}
            </button>
          ) : (
            <span
              data-testid="month-calendar-year"
              className="text-sm font-bold text-gray-800 tabular-nums w-11 text-center"
            >
              {viewYear}
            </span>
          )}
          <button
            type="button"
            aria-label="Next year"
            disabled={viewYear >= curYear}
            onClick={() => setViewYear((y) => y + 1)}
            className="p-1 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div data-testid="month-calendar-grid" className="grid grid-cols-3 gap-1.5">
        {MONTHS_SHORT.map((name, idx) => {
          const monthValue = `${viewYear}-${pad2(idx + 1)}`;
          const isFuture =
            viewYear > curYear || (viewYear === curYear && idx > curMonth);
          const isSelected = value === monthValue;
          const isCurrent = viewYear === curYear && idx === curMonth;
          return (
            <button
              key={monthValue}
              type="button"
              disabled={isFuture}
              onClick={() => onSelect(monthValue)}
              className={cn(
                "py-2 rounded-lg text-xs font-semibold transition-colors",
                isSelected
                  ? "bg-brand-600 text-white shadow-sm"
                  : isFuture
                    ? "text-gray-300 cursor-not-allowed"
                    : isCurrent
                      ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
                      : "text-gray-600 hover:bg-gray-100",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
