"use client";

import React from "react";
import { formatINRCompact } from "@/lib/format";
import {
  DashCard,
  NotAvailable,
  ProgressBar,
  TABLE_HEAD,
} from "@/components/dashboard/redesign/primitives";
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

  // ID 89 — the redesign's card (DashCard) and bars (ProgressBar); same data.
  return (
    <DashCard
      title="Expenses by department and project"
      caption={grandTotal > 0 ? `This month · ${formatINRCompact(grandTotal)} approved` : "This month"}
    >
      {grandTotal === 0 ? (
        <NotAvailable empty reason="No expenses recorded this month." />
      ) : (
        <div className="space-y-6">
          {/* By department */}
          <div>
            <p className={`${TABLE_HEAD} mb-2`}>By department</p>
            <ul className="space-y-2.5">
              {departments.map((d) => {
                const pct = grandTotal > 0 ? (d.total / grandTotal) * 100 : 0;
                return (
                  <li key={d.department}>
                    <div className="flex items-center justify-between text-[13px] mb-1">
                      <span className="font-medium text-ink">
                        {expenseDepartmentLabel(d.department)}
                      </span>
                      <span className="font-bold text-brand-navy tabular-nums">
                        {formatINRCompact(d.total)}
                      </span>
                    </div>
                    <ProgressBar pct={Math.max(pct, 2)} height={8} />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* By project tag */}
          <div>
            <p className={`${TABLE_HEAD} mb-2`}>By project</p>
            {projects.length === 0 ? (
              <p className="text-xs text-ink-muted">No project-tagged expenses.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {projects.map((p) => (
                  <li
                    key={`${p.department}-${p.project_tag}`}
                    className="py-2 flex items-center justify-between text-[13px]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink truncate">{p.project_tag}</p>
                      <p className="text-[11px] text-ink-muted">
                        {expenseDepartmentLabel(p.department)}
                      </p>
                    </div>
                    <span className="font-bold text-brand-navy tabular-nums ml-3">
                      {formatINRCompact(p.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </DashCard>
  );
}
