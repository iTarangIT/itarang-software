"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FileText } from "lucide-react";
import { Modal } from "@/components/leads/lead-v2-modals";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { expenseBucketLabel, expenseDepartmentLabel } from "@/lib/expenses";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import {
  EMPTY_EXPENSE_FILTERS,
  ExpenseBucketPanel,
  type ExpenseFilters,
} from "./ExpenseBucketPanel";

export type DrillMetric =
  | "purchases"
  | "sales"
  | "expenses"
  | "inventory"
  | "outstanding";

interface DrillDownModalProps {
  metric: DrillMetric;
  title: string;
  /** Query string for the window, e.g. "period=mtd" or "month=2026-06". */
  params?: string;
  onClose: () => void;
}

type Col = {
  key: string;
  label: string;
  align?: "right";
  render?: (row: Record<string, unknown>) => React.ReactNode;
};

const money = (v: unknown) => formatINRCompact(Number(v || 0));
const dateIN = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString("en-IN") : "—";
const txt = (v: unknown) => (v == null || v === "" ? "—" : String(v));

// Whole days a due date is past today (0 if not yet due / no due date).
const overdueDays = (v: unknown): number => {
  if (!v) return 0;
  const due = new Date(v as string);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date();
  const days = Math.floor(
    (today.setHours(0, 0, 0, 0) - due.setHours(0, 0, 0, 0)) / 86400000,
  );
  return days > 0 ? days : 0;
};

const COLUMNS: Record<DrillMetric, Col[]> = {
  purchases: [
    { key: "oem_invoice_number", label: "OEM Inv #", render: (r) => txt(r.oem_invoice_number) },
    { key: "oem_name", label: "OEM", render: (r) => txt(r.oem_name) },
    { key: "serial_number", label: "Serial", render: (r) => txt(r.serial_number) },
    { key: "model_type", label: "Model", render: (r) => txt(r.model_type) },
    { key: "oem_invoice_date", label: "Date", render: (r) => dateIN(r.oem_invoice_date) },
    { key: "status", label: "Status", render: (r) => txt(r.status) },
    { key: "final_amount", label: "Amount", align: "right", render: (r) => money(r.final_amount) },
  ],
  sales: [
    // Invoice-level fields render only on the first row of each invoice group so
    // multi-product invoices read as grouped rows, not duplicated headers.
    { key: "invoice_number", label: "Invoice #", render: (r) => (r._first ? txt(r.invoice_number) : "") },
    { key: "customer_name", label: "Customer", render: (r) => (r._first ? txt(r.customer_name) : "") },
    { key: "invoice_date", label: "Date", render: (r) => (r._first ? dateIN(r.invoice_date) : "") },
    { key: "product_name", label: "Product", render: (r) => txt(r.product_name) },
    { key: "quantity", label: "Qty", align: "right", render: (r) => txt(r.quantity) },
    { key: "status", label: "Status", render: (r) => (r._first ? txt(r.status) : "") },
    { key: "total", label: "Total", align: "right", render: (r) => (r._first ? money(r.total) : "") },
    {
      key: "invoice",
      label: "Invoice",
      render: (r) => {
        const id = r.zoho_invoice_id;
        if (!id || !r._first) return "—";
        return (
          <a
            href={`/api/admin/zoho/invoices/${id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 font-semibold hover:underline"
          >
            <FileText className="w-3.5 h-3.5" /> View
          </a>
        );
      },
    },
  ],
  expenses: [
    { key: "invoice_number", label: "Invoice #", render: (r) => txt(r.invoice_number) },
    { key: "vendor", label: "Vendor", render: (r) => txt(r.vendor) },
    { key: "department", label: "Dept", render: (r) => expenseDepartmentLabel(r.department as string) },
    { key: "bucket", label: "Bucket", render: (r) => expenseBucketLabel(r.bucket as string) },
    { key: "project_tag", label: "Project", render: (r) => txt(r.project_tag) },
    { key: "created_at", label: "Date Added", render: (r) => dateIN(r.created_at) },
    { key: "expense_date", label: "Invoice Date", render: (r) => dateIN(r.expense_date) },
    { key: "amount", label: "Amount", align: "right", render: (r) => money(r.amount) },
    {
      key: "bill",
      label: "Bill",
      render: (r) => {
        const url = r.bill_url;
        if (!url) return "—";
        return (
          <a
            href={String(url)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 font-semibold hover:underline"
          >
            <FileText className="w-3.5 h-3.5" /> View
          </a>
        );
      },
    },
  ],
  inventory: [
    { key: "serial_number", label: "Serial", render: (r) => txt(r.serial_number) },
    { key: "model_type", label: "Model", render: (r) => txt(r.model_type) },
    { key: "oem_name", label: "OEM", render: (r) => txt(r.oem_name) },
    { key: "status", label: "Status", render: (r) => txt(r.status) },
    { key: "final_amount", label: "Value", align: "right", render: (r) => money(r.final_amount) },
  ],
  outstanding: [
    { key: "invoice_number", label: "Invoice #", render: (r) => txt(r.invoice_number) },
    { key: "customer_name", label: "Customer", render: (r) => txt(r.customer_name) },
    { key: "invoice_date", label: "Date", render: (r) => dateIN(r.invoice_date) },
    { key: "due_date", label: "Due", render: (r) => dateIN(r.due_date) },
    { key: "total", label: "Total", align: "right", render: (r) => money(r.total) },
    { key: "balance", label: "Balance", align: "right", render: (r) => money(r.balance) },
    {
      key: "overdue",
      label: "Overdue",
      align: "right",
      render: (r) => {
        const d = overdueDays(r.due_date);
        return d > 0 ? (
          <span className="font-semibold text-rose-600">{d}d</span>
        ) : (
          "—"
        );
      },
    },
  ],
};

export function DrillDownModal({ metric, title, params, onClose }: DrillDownModalProps) {
  // E-219 — the expenses drill-down's own filters. Held here rather than inside
  // the panel because they narrow BOTH the breakdown above and the list below,
  // and the two must never be describing different sets of rows.
  //
  // Every one of them is applied server-side. The list stops at ROW_CAP (500),
  // so filtering the fetched rows on the client would show a subset of a
  // department while the count beside the dropdown stated the true one.
  const [filters, setFilters] = React.useState<ExpenseFilters>(EMPTY_EXPENSE_FILTERS);

  // A month or a range picked in the panel REPLACES the window inherited from
  // the page's filter bar. Both are the same kind of statement — which days
  // this is about — so the more specific one wins outright rather than
  // intersecting, which would silently return nothing whenever they disagree.
  const windowParams = React.useMemo(() => {
    if (filters.month) return `month=${filters.month}`;
    if (filters.from || filters.to) {
      const sp = new URLSearchParams({ period: "range" });
      if (filters.from) sp.set("from", filters.from);
      if (filters.to) sp.set("to", filters.to);
      return sp.toString();
    }
    return params ?? "";
  }, [filters.month, filters.from, filters.to, params]);

  const rowParams = [
    windowParams,
    filters.bucket && `bucket=${encodeURIComponent(filters.bucket)}`,
    filters.department && `department=${encodeURIComponent(filters.department)}`,
  ]
    .filter(Boolean)
    .join("&");
  const qs = rowParams ? `?${rowParams}` : "";

  const { data, isLoading, error } = useQuery({
    queryKey: ["ceo-drill-down", metric, rowParams],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/drill-down/${metric}${qs}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load details");
      const j = await r.json();
      return j.data as { metric: string; total: number; rows: Record<string, unknown>[] };
    },
  });

  const cols = COLUMNS[metric];
  const rows = React.useMemo(() => data?.rows ?? [], [data]);
  const paged = usePagination(rows);

  // Reset to page one whenever the filters change. Landing on page 4 of a
  // freshly-filtered two-page list reads as an empty result.
  React.useEffect(() => {
    paged.setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowParams]);

  // The breakdown follows the window but NOT the department/bucket filters —
  // it has to keep showing the whole window's split, or selecting a department
  // would leave it as the only bar on the strip and the counts in the dropdown
  // would all collapse to the one already chosen.
  const breakdown =
    metric === "expenses" ? (
      <ExpenseBucketPanel
        params={windowParams}
        filters={filters}
        onFiltersChange={setFilters}
      />
    ) : null;

  const filtered =
    Boolean(filters.department) || Boolean(filters.bucket);

  return (
    <Modal isOpen onClose={onClose} title={title} size="xl">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <p className="text-sm text-rose-600 py-8 text-center">Couldn&apos;t load details.</p>
      ) : rows.length === 0 ? (
        <div className="space-y-4">
          {breakdown}
          <p className="text-sm text-gray-400 italic py-8 text-center">
            {filtered
              ? "No records match these filters for the period."
              : "No records in this period."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {breakdown}
          {/* The row count lives in the pagination caption below the table, so
              it is stated once. What belongs here is the total — which covers
              every matching row, not the page on screen, because a per-page
              subtotal on a financial list invites reading it as the total. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-gray-500">
              {filtered ? "Filtered" : ""}
            </span>
            <p className="text-sm font-bold text-gray-900">
              Total: {formatINRExact(data?.total ?? 0)}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className={`py-2 px-2 font-semibold ${c.align === "right" ? "text-right" : ""}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.pageItems.map((row, i) => (
                  <tr key={paged.from + i} className="border-b border-gray-50">
                    {cols.map((c) => (
                      <td
                        key={c.key}
                        className={`py-2.5 px-2 text-xs text-gray-700 ${
                          c.align === "right" ? "text-right font-semibold text-gray-900" : ""
                        }`}
                      >
                        {c.render ? c.render(row) : txt(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={paged.page}
            pageCount={paged.pageCount}
            onPageChange={paged.setPage}
            total={paged.total}
            from={paged.from}
            to={paged.to}
            noun="records"
          />
        </div>
      )}
    </Modal>
  );
}
