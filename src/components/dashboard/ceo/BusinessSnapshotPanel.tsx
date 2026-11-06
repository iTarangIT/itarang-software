"use client";

// ID 215 (5 Nov): the panel's three tiles (Purchases from OEM / Sales to Dealer /
// Other Expenses) and their own period picker repeated the "Revenue minus
// purchases and expenses" strip at the top of Revenue & costs: same rule, but
// a second period, so one page could show two different figures. The strip is
// now the only copy (its tiles open the same drill-downs); this panel keeps
// what is not shown elsewhere: the manual sales upload and the recent lists.

import React from "react";
import { cn } from "@/lib/utils";
import { formatINRCompact } from "@/lib/format";
import { DashCard, TABLE_HEAD } from "@/components/dashboard/redesign/primitives";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import { ManualSalesUpload } from "./ManualSalesUpload";
import { expenseBucketLabel } from "@/lib/expenses";

/** Rows per page in the two recent lists — they are a glance, not a ledger. */
const RECENT_PAGE_SIZE = 5;

interface RecentInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  total: string | null;
  status: string | null;
}

interface RecentExpense {
  id: string;
  category: string;
  vendor?: string | null;
  bucket?: string | null;
  amount: string;
  approved_at: string | null;
  submitter_name: string | null;
}

interface Props {
  recentInvoices?: RecentInvoice[];
  recentExpenses?: RecentExpense[];
}

const formatINR = (n: number) => formatINRCompact(n);

/** C23: vendor first; a bare "Invoice" category says nothing, so the bucket next. */
function expenseName(exp: RecentExpense): string {
  const vendor = exp.vendor?.trim();
  if (vendor) return vendor;
  const generic = !exp.category || exp.category.trim().toLowerCase() === "invoice";
  if (generic && exp.bucket) return expenseBucketLabel(exp.bucket);
  return exp.category || "Expense";
}

export function BusinessSnapshotPanel({ recentInvoices = [], recentExpenses = [] }: Props) {
  // E-219 — both recent lists are paged five at a time, with the compact control.
  const pagedInvoices = usePagination(recentInvoices, RECENT_PAGE_SIZE);
  const pagedExpenses = usePagination(recentExpenses, RECENT_PAGE_SIZE);

  return (
    <DashCard>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-brand-navy">Recent invoices and expenses</h2>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <ManualSalesUpload />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-4">
        <div>
          <p className={cn(TABLE_HEAD, "mb-2")}>Recent invoices</p>
          {recentInvoices.length === 0 ? (
            <p data-testid="recent-invoices-empty" className="text-xs text-ink-muted">No invoices synced yet.</p>
          ) : (
            <>
            <ul data-testid="recent-invoices-list" className="divide-y divide-border/60">
              {pagedInvoices.pageItems.map((inv) => (
                <li
                  key={inv.id}
                  className="py-2 flex items-center justify-between text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">
                      {inv.customer_name || "—"}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {inv.invoice_number || ""} · {inv.invoice_date || ""}
                    </p>
                  </div>
                  <span className="font-bold text-brand-navy tabular-nums ml-3">
                    {formatINR(Number(inv.total || 0))}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={pagedInvoices.page}
              pageCount={pagedInvoices.pageCount}
              onPageChange={pagedInvoices.setPage}
              total={pagedInvoices.total}
              from={pagedInvoices.from}
              to={pagedInvoices.to}
              noun="invoices"
              compact
            />
            </>
          )}
        </div>

        <div>
          <p className={cn(TABLE_HEAD, "mb-2")}>Recent approved expenses</p>
          {recentExpenses.length === 0 ? (
            <p data-testid="recent-expenses-empty" className="text-xs text-ink-muted">No approved expenses yet.</p>
          ) : (
            <>
            <ul data-testid="recent-expenses-list" className="divide-y divide-border/60">
              {pagedExpenses.pageItems.map((exp) => (
                <li
                  key={exp.id}
                  className="py-2 flex items-center justify-between text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">
                      {expenseName(exp)}
                    </p>
                    <p className="text-[11px] text-ink-muted truncate">
                      {exp.submitter_name || "—"}
                    </p>
                  </div>
                  <span className="font-bold text-brand-navy tabular-nums ml-3">
                    {formatINR(Number(exp.amount || 0))}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={pagedExpenses.page}
              pageCount={pagedExpenses.pageCount}
              onPageChange={pagedExpenses.setPage}
              total={pagedExpenses.total}
              from={pagedExpenses.from}
              to={pagedExpenses.to}
              noun="expenses"
              compact
            />
            </>
          )}
        </div>
      </div>
    </DashCard>
  );
}
