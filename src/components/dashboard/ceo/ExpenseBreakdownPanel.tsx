"use client";

import React from "react";
import { Receipt, FolderKanban } from "lucide-react";
import { formatINRCompact } from "@/lib/format";
import { expenseDepartmentLabel } from "@/lib/expenses";

interface DepartmentRow {
  department: string;
  total: number;
}

interface ProjectRow {
  department: string;
  project_tag: string;
  total: number;
}

interface Props {
  byDepartment?: DepartmentRow[];
  byProject?: ProjectRow[];
}

export function ExpenseBreakdownPanel({ byDepartment = [], byProject = [] }: Props) {
  const departments = [...byDepartment].sort((a, b) => b.total - a.total);
  const projects = [...byProject]
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const grandTotal = departments.reduce((sum, d) => sum + d.total, 0);

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-5">
        <Receipt className="w-4 h-4 text-brand-600" />
        Expense Breakdown (MTD)
      </h3>

      {grandTotal === 0 ? (
        <p className="text-[11px] text-gray-400 italic">No expenses recorded this month.</p>
      ) : (
        <div className="space-y-6">
          {/* By department */}
          <div>
            <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2">
              By Department
            </p>
            <ul className="space-y-2">
              {departments.map((d) => {
                const pct = grandTotal > 0 ? (d.total / grandTotal) * 100 : 0;
                return (
                  <li key={d.department}>
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="font-medium text-gray-700">
                        {expenseDepartmentLabel(d.department)}
                      </span>
                      <span className="font-bold text-gray-900">
                        {formatINRCompact(d.total)}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* By project tag */}
          <div>
            <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2 flex items-center gap-1">
              <FolderKanban className="w-3 h-3" />
              By Project
            </p>
            {projects.length === 0 ? (
              <p className="text-[11px] text-gray-400 italic">No project-tagged expenses.</p>
            ) : (
              <ul className="divide-y divide-gray-50">
                {projects.map((p) => (
                  <li
                    key={`${p.department}-${p.project_tag}`}
                    className="py-2 flex items-center justify-between text-[12px]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">{p.project_tag}</p>
                      <p className="text-[10px] text-gray-400">
                        {expenseDepartmentLabel(p.department)}
                      </p>
                    </div>
                    <span className="font-bold text-gray-800 ml-3">
                      {formatINRCompact(p.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
