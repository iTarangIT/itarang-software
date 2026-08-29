"use client";

/**
 * The CEO dashboard's Expense Ledger card.
 *
 * Two views behind one toggle. **Summary** — the landing view — groups the
 * window's invoices by department: name, invoice count, total spend, each row
 * expandable in place to show the invoices behind it. **Detail** is the flat
 * one-row-per-invoice table this card used to be. Both read the same filters,
 * so switching between them never silently changes what is being counted.
 *
 * The data moved server-side to make that summary honest. The card previously
 * rendered `m.ai_expenses` from /api/dashboard/ceo — a query with no window and
 * a hard limit of 200 — and filtered and totalled it in the browser. It
 * therefore ignored the MTD/YTD/FY/range bar directly above it and capped every
 * figure at the most recent 200 invoices ever recorded. That is survivable for a
 * list of rows and not for a total, which invites a trust a row list does not.
 *
 * One thing worth knowing when reconciling this card against its neighbours:
 * this ledger counts `source='ai'` invoices. The Other Expenses tile and the
 * Expense Breakdown card use approvedExpenseInWindow(), which has no source
 * filter and so also counts approved manual submissions. This total is expected
 * to be the smaller of the two; the note under the table says so on screen.
 */

import React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import {
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";
import { LedgerFilters } from "./expense-ledger/LedgerFilters";
import { LedgerSummaryTable } from "./expense-ledger/LedgerSummaryTable";
import { LedgerDetailTable } from "./expense-ledger/LedgerDetailTable";
import {
  EMPTY_LEDGER_FILTERS,
  hasActiveLedgerFilter,
  hasDateOverride,
  ledgerFilterParams,
  ledgerWindowParams,
  type LedgerFilterState,
  type LedgerResponse,
} from "./expense-ledger/types";

type LedgerView = "summary" | "detail";

interface Props {
  /** The dashboard window as a query string, from ceoWindowParams(). */
  params?: string;
}

export function ExpenseLedgerPanel({ params }: Props) {
  const [view, setView] = React.useState<LedgerView>("summary");
  const [filters, setFilters] = React.useState<LedgerFilterState>(
    EMPTY_LEDGER_FILTERS,
  );

  // The window and every filter in one string, so it is both what we request
  // and — as the query key — what React Query caches on. Deriving the key from
  // anything narrower is how a filter change serves a stale answer.
  const queryString = React.useMemo(() => {
    // The window comes from the ledger's own date boxes when they are set, and
    // from the dashboard bar otherwise.
    const sp = ledgerWindowParams(params, filters);
    for (const [k, v] of ledgerFilterParams(filters)) sp.set(k, v);
    return sp.toString();
  }, [params, filters]);

  const { data, isLoading, isFetching, error, refetch } =
    useQuery<LedgerResponse>({
      queryKey: ["ceo-expense-ledger", queryString],
      queryFn: async () => {
        const res = await fetch(
          `/api/dashboard/ceo/expense-ledger?${queryString}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message || "Failed to load the ledger");
        }
        const json = await res.json();
        return json.data as LedgerResponse;
      },
      /**
       * Keep the previous answer on screen while the next one loads.
       *
       * Without it, every filter change blanks the table, collapses each open
       * department into a spinner and jumps the page height. The stale rows are
       * dimmed instead, which reads as "updating" rather than "gone".
       */
      placeholderData: keepPreviousData,
    });

  const hasActiveFilter = hasActiveLedgerFilter(filters);

  /**
   * "View all" on a department: switch to Detail with that department filtered.
   *
   * It sets the same filter the dropdown sets, so the two cannot disagree and
   * the Detail view arrives showing exactly the rows the summary row counted.
   */
  const viewAllForDepartment = (departmentKey: string) => {
    setFilters((prev) => ({
      ...prev,
      department: departmentKey,
      project: "all",
      vendor: "all",
    }));
    setView("detail");
  };

  // Names the active filters so the totals row says what it is totalling.
  const totalCaption = React.useMemo(() => {
    const parts: string[] = [
      filters.department === "all"
        ? "all departments"
        : expenseDepartmentLabel(filters.department),
    ];
    if (filters.bucket !== "all") parts.push(expenseBucketLabel(filters.bucket));
    if (filters.project !== "all") parts.push(filters.project);
    if (filters.vendor !== "all") parts.push(filters.vendor);
    if (filters.search.trim()) parts.push(`“${filters.search.trim()}”`);
    return parts.join(" · ");
  }, [filters]);

  const tabCls = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
      active
        ? "bg-white text-gray-900 shadow-sm"
        : "text-gray-500 hover:text-gray-700"
    }`;

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Receipt className="w-4 h-4 text-brand-600" />
          Expense Ledger
          {data && (
            <span className="text-[11px] font-medium text-gray-400">
              ({data.grandCount}{" "}
              {data.grandCount === 1 ? "entry" : "entries"} · {data.label})
            </span>
          )}
          {/* The card is showing a different span than the period bar above it.
              Said out loud, because a total under the wrong assumed period is
              the most expensive way for this screen to be misread. */}
          {hasDateOverride(filters) && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-600 bg-brand-50 rounded px-1.5 py-0.5">
              Custom dates
            </span>
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Ledger view"
            className="flex items-center gap-1 p-1 rounded-xl bg-gray-100"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "summary"}
              onClick={() => setView("summary")}
              className={tabCls(view === "summary")}
            >
              Summary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "detail"}
              onClick={() => setView("detail")}
              className={tabCls(view === "detail")}
            >
              Detail
            </button>
          </div>
          <LedgerFilters
            value={filters}
            onChange={setFilters}
            projectOptions={data?.projects ?? []}
            vendorOptions={data?.vendors ?? []}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-gray-50 rounded animate-pulse" />
          ))}
        </div>
      ) : error ? (
        // Rendered inside the card rather than returning null: this panel IS
        // the ledger, and showing nothing would read as "no expenses".
        <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>
            {error instanceof Error
              ? error.message
              : "Failed to load the ledger"}
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            className="font-semibold hover:underline shrink-0"
          >
            Retry
          </button>
        </div>
      ) : !data || data.grandCount === 0 ? (
        // Two empties, because they call for different actions. "Nothing in
        // this period" is a fact about the window; "nothing matches" is a
        // filter the reader can undo, so it comes with the undo.
        hasActiveFilter ? (
          <p className="text-[11px] text-gray-400 italic">
            No expenses match these filters.{" "}
            <button
              type="button"
              onClick={() => setFilters(EMPTY_LEDGER_FILTERS)}
              className="not-italic font-semibold text-brand-600 hover:underline"
            >
              Clear filters
            </button>
          </p>
        ) : (
          <p className="text-[11px] text-gray-400 italic">
            No tracked expenses in this period.
          </p>
        )
      ) : (
        <div className={isFetching ? "opacity-60 transition-opacity" : undefined}>
          {view === "summary" ? (
            <LedgerSummaryTable
              departments={data.departments}
              rows={data.rows}
              grandTotal={data.grandTotal}
              grandCount={data.grandCount}
              totalCaption={totalCaption}
              onViewAll={viewAllForDepartment}
            />
          ) : (
            <LedgerDetailTable
              rows={data.rows}
              grandTotal={data.grandTotal}
              grandCount={data.grandCount}
              totalCaption={totalCaption}
              resetKey={queryString}
            />
          )}

          {/* Says which rows are on hand versus which were counted. The totals
              above are computed over the whole window either way — this is
              about the LIST being partial, not the numbers. */}
          {data.capped && (
            <p className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              Showing the most recent {data.cap.toLocaleString("en-IN")} of{" "}
              {data.grandCount.toLocaleString("en-IN")} invoices. Department
              counts and totals cover all of them; narrow the date range or the
              filters to see the rest individually.
            </p>
          )}

          <p className="mt-3 text-[10px] text-gray-400">
            Counts AI-tracked invoices only. The Other Expenses figures on this
            dashboard also include approved manual expense submissions, so they
            will read higher.
          </p>
        </div>
      )}
    </div>
  );
}
