"use client";

/**
 * The Expense Ledger's flat, one-row-per-invoice view — what the whole card
 * used to be, now the Detail half of the toggle.
 *
 * Lifted out of ExpenseLedgerPanel largely unchanged. The one substantive
 * difference: the totals row no longer reduces the rows on screen. It prints
 * the figures the server computed over the entire window, so it stays right
 * when the row list is capped.
 */

import React from "react";
import { FileText } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import {
  SortableTh,
  sortRows,
  useTableSort,
  type SortSpec,
} from "@/components/shared/TableSort";
import {
  expenseBucketColor,
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";
import { CELL, HEAD_CELL, type LedgerRow } from "./types";

/**
 * E-224 — what each column sorts by.
 *
 * The Date column renders `expense_date` and falls back to `created_at`, so it
 * has to sort by the same COALESCE. Ordering by the raw column would put every
 * dateless row in one clump that reads nothing like what the cells show.
 *
 * Department and Bucket sort by their label, because the label is what is on
 * screen — nobody is ordering by the string "ops".
 */
const LEDGER_SORT_SPECS: SortSpec<LedgerRow>[] = [
  { key: "date", type: "date", value: (r) => r.expense_date ?? r.created_at },
  { key: "vendor", type: "text" },
  {
    key: "department",
    type: "text",
    value: (r) => expenseDepartmentLabel(r.department),
  },
  { key: "bucket", type: "text", value: (r) => expenseBucketLabel(r.bucket) },
  { key: "project_tag", type: "text" },
  { key: "submitter_name", type: "text" },
  { key: "amount", type: "number" },
];

interface Props {
  rows: LedgerRow[];
  /** Server-computed over the whole window, not over `rows`. */
  grandTotal: number;
  grandCount: number;
  /** Caption for the totals row, naming the active filters. */
  totalCaption: string;
  /**
   * Changes whenever the window or a filter changes.
   *
   * Paging back to 1 is not just tidiness: usePagination clamps a page past the
   * end, so nothing breaks, but landing on page 3 of a list you have just
   * narrowed shows its middle with no indication the top moved. Deliberately
   * NOT the `rows` array — that gets a new identity on every background
   * refetch, which would yank the reader back to page 1 mid-read.
   */
  resetKey: string;
}

export function LedgerDetailTable({
  rows,
  grandTotal,
  grandCount,
  totalCaption,
  resetKey,
}: Props) {
  const { sort, toggle, comparator } = useTableSort<LedgerRow>(LEDGER_SORT_SPECS);
  const sorted = React.useMemo(
    () => sortRows(rows, comparator),
    [rows, comparator],
  );

  const paged = usePagination(sorted);

  // Re-sorting reorders the whole list, and re-filtering replaces it, so
  // holding page 3 would show the middle of something the reader has not seen
  // the top of.
  const { setPage } = paged;
  React.useEffect(() => {
    setPage(1);
  }, [setPage, sort?.key, sort?.dir, resetKey]);

  return (
    <>
      {/* min-w forces the horizontal scroll this wrapper already offers.
          Without it the table compresses to the card instead, which is how
          eight columns ended up crushed into each other on a half-width
          dashboard column. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
              <SortableTh label="Date" sortKey="date" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Vendor" sortKey="vendor" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Department" sortKey="department" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Bucket" sortKey="bucket" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Project" sortKey="project_tag" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Added by" sortKey="submitter_name" sort={sort} onToggle={toggle} className={HEAD_CELL} />
              <SortableTh label="Amount" sortKey="amount" sort={sort} onToggle={toggle} align="right" className={HEAD_CELL} />
              <SortableTh label="Bill" sort={sort} onToggle={toggle} align="right" className={HEAD_CELL} />
            </tr>
          </thead>
          <tbody>
            {paged.pageItems.map((r) => (
              // align-top: a two-line vendor cell must not drag the single
              // line values in every other column down to its middle.
              <tr key={r.id} className="border-b border-gray-50 align-top">
                <td className={`py-3 ${CELL} text-xs text-gray-600 whitespace-nowrap`}>
                  {r.expense_date
                    ? new Date(r.expense_date).toLocaleDateString("en-IN")
                    : new Date(r.created_at).toLocaleDateString("en-IN")}
                </td>
                {/* The one column allowed to be long, and so the one that has
                    to be bounded — an unclipped legal name like "BHARATNXT
                    WAVE SERVICES PRIVATE LIMITED" otherwise steals width from
                    every column to its right. Full text stays on hover. */}
                <td className={`py-3 ${CELL} text-xs font-semibold text-gray-900`}>
                  <span className="block max-w-[220px] truncate" title={r.vendor || undefined}>
                    {r.vendor || "—"}
                  </span>
                  {r.description && (
                    <span
                      className="block text-[10px] font-normal text-gray-400 truncate max-w-[220px]"
                      title={r.description}
                    >
                      {r.description}
                    </span>
                  )}
                </td>
                <td className={`py-3 ${CELL} text-xs text-gray-700 whitespace-nowrap`}>
                  {expenseDepartmentLabel(r.department)}
                </td>
                <td className={`py-3 ${CELL} text-xs text-gray-700 whitespace-nowrap`}>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: expenseBucketColor(r.bucket) }}
                    />
                    {expenseBucketLabel(r.bucket)}
                  </span>
                </td>
                <td className={`py-3 ${CELL} text-xs text-gray-700`}>
                  <span className="block max-w-[160px] truncate" title={r.project_tag || undefined}>
                    {r.project_tag || "—"}
                  </span>
                </td>
                <td className={`py-3 ${CELL} text-xs text-gray-500 whitespace-nowrap`}>
                  {r.submitter_name || "—"}
                </td>
                <td
                  className={`py-3 ${CELL} text-xs font-bold text-gray-900 text-right whitespace-nowrap tabular-nums`}
                  title={formatINRExact(Number(r.amount))}
                >
                  ₹{Number(r.amount).toLocaleString("en-IN")}
                </td>
                <td className={`py-3 ${CELL} text-xs text-right whitespace-nowrap`}>
                  {r.bill_url ? (
                    <a
                      href={r.bill_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand-600 hover:underline font-semibold"
                    >
                      <FileText className="w-3 h-3 shrink-0" /> View
                    </a>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* The server's total over the whole window — not a reduce over the
                rows in hand, which would drop everything past the cap. */}
            <tr className="border-t border-gray-100">
              <td
                colSpan={6}
                className={`py-3 ${CELL} text-[11px] font-semibold uppercase tracking-wider text-gray-500`}
              >
                Total ({totalCaption}) · {grandCount}{" "}
                {grandCount === 1 ? "invoice" : "invoices"}
              </td>
              <td
                className={`py-3 ${CELL} text-sm font-bold text-gray-900 text-right whitespace-nowrap tabular-nums`}
                title={formatINRExact(grandTotal)}
              >
                {formatINRCompact(grandTotal)}
              </td>
              <td className={CELL} />
            </tr>
          </tfoot>
        </table>
      </div>
      <Pagination
        page={paged.page}
        pageCount={paged.pageCount}
        onPageChange={paged.setPage}
        total={paged.total}
        from={paged.from}
        to={paged.to}
        noun="expenses"
      />
    </>
  );
}
