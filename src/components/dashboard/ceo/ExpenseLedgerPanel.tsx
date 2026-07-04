"use client";

import React, { useMemo, useState } from "react";
import { Receipt, FileText } from "lucide-react";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { EXPENSE_DEPARTMENTS, expenseDepartmentLabel } from "@/lib/expenses";

interface LedgerRow {
  id: string;
  vendor: string | null;
  amount: string;
  description: string | null;
  department: string | null;
  project_tag: string | null;
  expense_date: string | null;
  bill_url: string | null;
  created_at: string;
  submitter_name: string | null;
}

interface Props {
  rows?: LedgerRow[];
}

export function ExpenseLedgerPanel({ rows = [] }: Props) {
  const [dept, setDept] = useState<string>("all");
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
        if (project !== "all" && r.project_tag !== project) return false;
        return true;
      }),
    [rows, dept, project],
  );

  const total = useMemo(
    () => filtered.reduce((sum, r) => sum + Number(r.amount || 0), 0),
    [filtered],
  );

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
                  <th className="py-2 font-semibold">Date</th>
                  <th className="py-2 font-semibold">Vendor</th>
                  <th className="py-2 font-semibold">Department</th>
                  <th className="py-2 font-semibold">Project</th>
                  <th className="py-2 font-semibold">Added by</th>
                  <th className="py-2 font-semibold text-right">Amount</th>
                  <th className="py-2 font-semibold text-right">Bill</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
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
                <tr className="border-t border-gray-100">
                  <td colSpan={5} className="py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Total ({dept === "all" ? "all departments" : expenseDepartmentLabel(dept)})
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
        </>
      )}
    </div>
  );
}
