"use client";

/**
 * E-219 — one paging control for every long list on the dashboard.
 *
 * Paging happens on the CLIENT, over rows that are already in hand. Every list
 * that uses this is server-capped well below the point where that matters (the
 * drill-down at 500 rows, the ledger and the recent lists lower still), so a
 * page change is instant and costs no round trip. It is not a substitute for a
 * LIMIT/OFFSET API — if a list ever needs to show more rows than its cap, the
 * cap is the thing to fix, not this.
 *
 * The row count is always stated in full ("Showing 1–25 of 137") because the
 * whole hazard of paging a financial list is mistaking page one for the lot.
 */

import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Slices `items` for the current page and clamps the page back into range when
 * the list shrinks under it — filtering a list down to two pages while sitting
 * on page five otherwise shows an empty table with no indication why.
 */
export function usePagination<T>(items: T[], pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount);

  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const start = (current - 1) * pageSize;
  const pageItems = React.useMemo(
    () => items.slice(start, start + pageSize),
    [items, start, pageSize],
  );

  return {
    page: current,
    setPage,
    pageCount,
    pageItems,
    total: items.length,
    /** 1-based inclusive bounds of what is on screen, for the caption. */
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, items.length),
  };
}

/**
 * Page numbers with the middle elided: 1 … 4 5 6 … 12. Always renders first and
 * last so the extent of the list is visible from any page.
 */
function pageNumbers(current: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out: (number | "gap")[] = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(pageCount - 1, current + 1);
  if (from > 2) out.push("gap");
  for (let p = from; p <= to; p++) out.push(p);
  if (to < pageCount - 1) out.push("gap");
  out.push(pageCount);
  return out;
}

interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Total row count across all pages. */
  total: number;
  from: number;
  to: number;
  /** What the rows are, for the caption: "invoices", "records". */
  noun?: string;
  /** Drops the page-number buttons, leaving the caption and prev/next. */
  compact?: boolean;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  total,
  from,
  to,
  noun = "records",
  compact = false,
}: PaginationProps) {
  // One page is not a navigation problem — but the count still matters, so the
  // caption stays and only the controls go.
  const showControls = pageCount > 1;

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-3">
      <p className="text-xs font-medium text-gray-500 tabular-nums">
        {total === 0
          ? `No ${noun}`
          : `Showing ${from.toLocaleString("en-IN")}–${to.toLocaleString(
              "en-IN",
            )} of ${total.toLocaleString("en-IN")} ${noun}`}
      </p>

      {showControls && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <PageButton
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            ariaLabel="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </PageButton>

          {!compact &&
            pageNumbers(page, pageCount).map((p, i) =>
              p === "gap" ? (
                <span
                  key={`gap-${i}`}
                  className="px-1 text-xs text-gray-300 select-none"
                >
                  …
                </span>
              ) : (
                <PageButton
                  key={p}
                  onClick={() => onPageChange(p)}
                  active={p === page}
                  ariaLabel={`Page ${p}`}
                  ariaCurrent={p === page}
                >
                  {p}
                </PageButton>
              ),
            )}

          {compact && (
            <span className="px-2 text-xs font-semibold text-gray-600 tabular-nums">
              {page} / {pageCount}
            </span>
          )}

          <PageButton
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            ariaLabel="Next page"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </PageButton>
        </nav>
      )}
    </div>
  );
}

function PageButton({
  children,
  onClick,
  disabled = false,
  active = false,
  ariaLabel,
  ariaCurrent = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  ariaLabel: string;
  ariaCurrent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={ariaCurrent ? "page" : undefined}
      className={`min-w-[28px] h-7 px-2 grid place-items-center rounded-md text-xs font-semibold transition-colors ${
        active
          ? "bg-brand-600 text-white"
          : "text-gray-600 enabled:hover:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed"
      }`}
    >
      {children}
    </button>
  );
}
