"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Receipt, FileText } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import {
  SortableTh,
  sortRows,
  useTableSort,
  type SortSpec,
} from "@/components/shared/TableSort";
import {
  EXPENSE_BUCKETS,
  EXPENSE_DEPARTMENTS,
  UNCLASSIFIED_BUCKET_KEY,
  expenseBucketColor,
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";

interface LedgerRow {
  id: string;
  vendor: string | null;
  amount: string;
  description: string | null;
  department: string | null;
  bucket: string | null;
  project_tag: string | null;
  expense_date: string | null;
  bill_url: string | null;
  created_at: string;
  submitter_name: string | null;
}

interface Props {
  rows?: LedgerRow[];
}

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

export function ExpenseLedgerPanel({ rows = [] }: Props) {
  const [dept, setDept] = useState<string>("all");
  const [bucket, setBucket] = useState<string>("all");
  const [project, setProject] = useState<string>("all");

  // Project options scoped to the selected department.
  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    rows
      .filter((r) => dept === "all" || (r.department ?? "unassigned") === dept)
      .forEach((r) => r.project_tag && set.add(r.project_tag));
    return Array.from(set).sort();
  }, [rows, dept]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const d = r.department ?? "unassigned";
        if (dept !== "all" && d !== dept) return false;
        // E-218 — a null bucket is a pre-backfill row, selectable as
        // "Unclassified" so it can be found and fixed rather than hidden.
        if (bucket !== "all" && (r.bucket ?? UNCLASSIFIED_BUCKET_KEY) !== bucket)
          return false;
        if (project !== "all" && r.project_tag !== project) return false;
        return true;
      }),
    [rows, dept, bucket, project],
  );

  const total = useMemo(
    () => filtered.reduce((sum, r) => sum + Number(r.amount || 0), 0),
    [filtered],
  );

  // E-224 — click-to-sort headers. Sorted after filtering so the two compose:
  // narrowing to one department and then ordering by amount asks a single
  // question, not two that fight.
  const { sort, toggle, comparator } = useTableSort<LedgerRow>(LEDGER_SORT_SPECS);
  const sorted = useMemo(() => sortRows(filtered, comparator), [filtered, comparator]);

  // E-219 — the ledger grew past the point where scrolling it was reasonable.
  // usePagination clamps the page when a filter shrinks the list under it.
  const paged = usePagination(sorted);

  // Re-sorting reorders the whole list, so holding page 3 would show its middle
  // with nothing indicating that the top had changed.
  const { setPage } = paged;
  useEffect(() => {
    setPage(1);
  }, [setPage, sort?.key, sort?.dir]);

  const selectCls =
    "px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-700 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Receipt className="w-4 h-4 text-brand-600" />
          Expense Ledger
          <span className="text-[11px] font-medium text-gray-400">
            ({filtered.length} {filtered.length === 1 ? "entry" : "entries"})
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <select
            className={selectCls}
            value={dept}
            onChange={(e) => {
              setDept(e.target.value);
              setProject("all");
            }}
          >
            <option value="all">All departments</option>
            {EXPENSE_DEPARTMENTS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
            <option value="unassigned">Unassigned</option>
          </select>
          <select
            className={selectCls}
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
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
            className={selectCls}
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={projectOptions.length === 0}
          >
            <option value="all">All projects</option>
            {projectOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-400 italic">No tracked expenses yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <SortableTh label="Date" sortKey="date" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Vendor" sortKey="vendor" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Department" sortKey="department" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Bucket" sortKey="bucket" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Project" sortKey="project_tag" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Added by" sortKey="submitter_name" sort={sort} onToggle={toggle} className="!px-0" />
                  <SortableTh label="Amount" sortKey="amount" sort={sort} onToggle={toggle} align="right" className="!px-0" />
                  <SortableTh label="Bill" sort={sort} onToggle={toggle} align="right" className="!px-0" />
                </tr>
              </thead>
              <tbody>
                {paged.pageItems.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-3 text-xs text-gray-600 whitespace-nowrap">
                      {r.expense_date
                        ? new Date(r.expense_date).toLocaleDateString("en-IN")
                        : new Date(r.created_at).toLocaleDateString("en-IN")}
                    </td>
                    <td className="py-3 text-xs font-semibold text-gray-900">
                      {r.vendor || "—"}
                      {r.description && (
                        <span className="block text-[10px] font-normal text-gray-400 truncate max-w-[220px]">
                          {r.description}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-xs text-gray-700">
                      {expenseDepartmentLabel(r.department)}
                    </td>
                    <td className="py-3 text-xs text-gray-700">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: expenseBucketColor(r.bucket) }}
                        />
                        {expenseBucketLabel(r.bucket)}
                      </span>
                    </td>
                    <td className="py-3 text-xs text-gray-700">{r.project_tag || "—"}</td>
                    <td className="py-3 text-xs text-gray-500">{r.submitter_name || "—"}</td>
                    <td className="py-3 text-xs font-bold text-gray-900 text-right whitespace-nowrap">
                      ₹{Number(r.amount).toLocaleString("en-IN")}
                    </td>
                    <td className="py-3 text-xs text-right">
                      {r.bill_url ? (
                        <a
                          href={r.bill_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-brand-600 hover:underline font-semibold"
                        >
                          <FileText className="w-3 h-3" /> View
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {/* Totals every filtered row, not the page on screen — this is
                    the ledger's bottom line and must not change as you page. */}
                <tr className="border-t border-gray-100">
                  <td colSpan={6} className="py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Total ({dept === "all" ? "all departments" : expenseDepartmentLabel(dept)}
                    {bucket !== "all" && ` · ${expenseBucketLabel(bucket)}`})
                  </td>
                  <td
                    className="py-3 text-sm font-bold text-gray-900 text-right whitespace-nowrap"
                    title={formatINRExact(total)}
                  >
                    {formatINRCompact(total)}
                  </td>
                  <td />
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
      )}
    </div>
  );
}
