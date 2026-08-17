"use client";

/**
 * The Expense Ledger's summary view: one row per department, expandable in
 * place to reveal that department's invoices.
 *
 * The two numbers on a summary row — invoice count and total — come from a SQL
 * GROUP BY over the whole window, NOT from counting the `rows` array. That
 * matters because `rows` is capped: a department can hold more invoices than
 * were fetched, and a count derived from what arrived would silently under-report
 * exactly when the ledger is busiest. When a department's fetched rows fall short
 * of its real count, the expanded list says so instead of pretending.
 */

import React, { Fragment, useId } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import {
  SortableTh,
  sortRows,
  useTableSort,
  type SortSpec,
} from "@/components/shared/TableSort";
import { expenseBucketColor, expenseBucketLabel } from "@/lib/expenses";
import {
  CELL,
  HEAD_CELL,
  type DepartmentSummary,
  type LedgerRow,
} from "./types";

/**
 * How many invoices a department shows before deferring to "View all".
 *
 * Small on purpose. The point of expanding a department here is to see what the
 * money went on, not to read the ledger — anyone who wants the full list is one
 * click from the Detail view, already filtered.
 */
const INLINE_ROWS = 10;

const SUMMARY_SORT_SPECS: SortSpec<DepartmentSummary>[] = [
  // Sorted by the label on screen, not the stored value — nobody is ordering
  // departments by the string "ops".
  { key: "department", type: "text", value: (d) => d.label },
  { key: "count", type: "number" },
  { key: "total", type: "number" },
];

interface Props {
  departments: DepartmentSummary[];
  rows: LedgerRow[];
  grandTotal: number;
  grandCount: number;
  /** Caption for the totals row, naming the active filters. */
  totalCaption: string;
  /** Switches to Detail view filtered to one department. */
  onViewAll: (departmentKey: string) => void;
}

export function LedgerSummaryTable({
  departments,
  rows,
  grandTotal,
  grandCount,
  totalCaption,
  onViewAll,
}: Props) {
  /**
   * Multi-open, keyed by department rather than by index, so an open row stays
   * open across a re-sort instead of the expansion jumping to whichever
   * department landed in that position.
   */
  const [openKeys, setOpenKeys] = React.useState<Set<string>>(() => new Set());

  // Scopes aria-controls to this instance. A fixed string id would collide if
  // the card were ever mounted twice on one page, and a screen reader would
  // point both disclosures at the same panel.
  const baseId = useId();

  const toggleRow = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const { sort, toggle, comparator } =
    useTableSort<DepartmentSummary>(SUMMARY_SORT_SPECS);
  const sorted = React.useMemo(
    () => sortRows(departments, comparator),
    [departments, comparator],
  );

  /**
   * Rows bucketed by department once, rather than filtering the array inside
   * every expanded row — with eight departments open that is eight passes over
   * the same list on each render.
   */
  const rowsByDept = React.useMemo(() => {
    const m = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      const key = r.department ?? "unassigned";
      const list = m.get(key);
      if (list) list.push(r);
      else m.set(key, [r]);
    }
    return m;
  }, [rows]);

  if (departments.length === 0) {
    return (
      <p className="text-[11px] text-gray-400 italic">
        No expenses match these filters.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
            <SortableTh
              label="Department"
              sortKey="department"
              sort={sort}
              onToggle={toggle}
              className={HEAD_CELL}
            />
            <SortableTh
              label="Invoices"
              sortKey="count"
              sort={sort}
              onToggle={toggle}
              align="right"
              className={HEAD_CELL}
            />
            <SortableTh
              label="Amount"
              sortKey="total"
              sort={sort}
              onToggle={toggle}
              align="right"
              className={HEAD_CELL}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => {
            const isOpen = openKeys.has(d.key);
            const deptRows = rowsByDept.get(d.key) ?? [];
            const shown = deptRows.slice(0, INLINE_ROWS);
            // `d.count` is the truth from SQL; deptRows is what survived the
            // row cap. They differ only when the ledger is capped.
            const hasMore = d.count > shown.length;
            const panelId = `${baseId}-${d.key}`;

            return (
              <Fragment key={d.key}>
                <tr
                  className={`border-b border-gray-50 ${isOpen ? "bg-gray-50/60" : ""}`}
                >
                  <td className={`py-3 ${CELL}`}>
                    {/* A real button, not a clickable <tr>: the row has to be
                        reachable and operable from the keyboard, and a tr with
                        an onClick is neither focusable nor announced. */}
                    <button
                      type="button"
                      onClick={() => toggleRow(d.key)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-900 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 rounded"
                    >
                      {isOpen ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                      )}
                      {d.label}
                    </button>
                  </td>
                  <td
                    className={`py-3 ${CELL} text-xs text-gray-700 text-right whitespace-nowrap tabular-nums`}
                  >
                    {d.count.toLocaleString("en-IN")}
                  </td>
                  <td
                    className={`py-3 ${CELL} text-xs font-bold text-gray-900 text-right whitespace-nowrap tabular-nums`}
                    title={formatINRExact(d.total)}
                  >
                    {formatINRCompact(d.total)}
                  </td>
                </tr>

                {isOpen && (
                  <tr className="border-b border-gray-50 bg-gray-50/40">
                    {/* The nested list is its own table inside one spanning
                        cell, so its columns cannot pull the summary's three
                        out of alignment. */}
                    <td id={panelId} colSpan={3} className="px-3 py-3 first:pl-0 last:pr-0">
                      {shown.length === 0 ? (
                        <p className="text-[11px] text-gray-400 italic">
                          No invoices fetched for this department.
                        </p>
                      ) : (
                        <table className="w-full text-sm">
                          <tbody>
                            {shown.map((r) => (
                              <tr key={r.id} className="align-top">
                                <td className="py-1.5 pr-3 text-[11px] text-gray-500 whitespace-nowrap">
                                  {r.expense_date
                                    ? new Date(r.expense_date).toLocaleDateString("en-IN")
                                    : new Date(r.created_at).toLocaleDateString("en-IN")}
                                </td>
                                <td className="py-1.5 pr-3 text-[11px] font-medium text-gray-800">
                                  <span
                                    className="block max-w-[240px] truncate"
                                    title={r.vendor || undefined}
                                  >
                                    {r.vendor || "—"}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-3 text-[11px] text-gray-500 whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span
                                      className="w-1.5 h-1.5 rounded-full shrink-0"
                                      style={{ backgroundColor: expenseBucketColor(r.bucket) }}
                                    />
                                    {expenseBucketLabel(r.bucket)}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-3 text-[11px] text-gray-500">
                                  <span
                                    className="block max-w-[140px] truncate"
                                    title={r.project_tag || undefined}
                                  >
                                    {r.project_tag || "—"}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-3 text-[11px] font-semibold text-gray-900 text-right whitespace-nowrap tabular-nums">
                                  ₹{Number(r.amount).toLocaleString("en-IN")}
                                </td>
                                <td className="py-1.5 text-[11px] text-right whitespace-nowrap">
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
                        </table>
                      )}

                      {hasMore && (
                        <button
                          type="button"
                          onClick={() => onViewAll(d.key)}
                          className="mt-2 text-[11px] font-semibold text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 rounded"
                        >
                          View all {d.count.toLocaleString("en-IN")} invoices →
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          {/* Totals every matching invoice in the window, not the departments
              on screen — this is the ledger's bottom line. */}
          <tr className="border-t border-gray-100">
            <td
              className={`py-3 ${CELL} text-[11px] font-semibold uppercase tracking-wider text-gray-500`}
            >
              Total ({totalCaption})
            </td>
            <td
              className={`py-3 ${CELL} text-xs font-semibold text-gray-700 text-right whitespace-nowrap tabular-nums`}
            >
              {grandCount.toLocaleString("en-IN")}
            </td>
            <td
              className={`py-3 ${CELL} text-sm font-bold text-gray-900 text-right whitespace-nowrap tabular-nums`}
              title={formatINRExact(grandTotal)}
            >
              {formatINRCompact(grandTotal)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
