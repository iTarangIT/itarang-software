"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/leads/lead-v2-modals";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { expenseDepartmentLabel } from "@/lib/expenses";

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
    { key: "invoice_number", label: "Invoice #", render: (r) => txt(r.invoice_number) },
    { key: "customer_name", label: "Customer", render: (r) => txt(r.customer_name) },
    { key: "invoice_date", label: "Date", render: (r) => dateIN(r.invoice_date) },
    { key: "status", label: "Status", render: (r) => txt(r.status) },
    { key: "total", label: "Total", align: "right", render: (r) => money(r.total) },
  ],
  expenses: [
    { key: "invoice_number", label: "Invoice #", render: (r) => txt(r.invoice_number) },
    { key: "vendor", label: "Vendor", render: (r) => txt(r.vendor) },
    { key: "department", label: "Dept", render: (r) => expenseDepartmentLabel(r.department as string) },
    { key: "project_tag", label: "Project", render: (r) => txt(r.project_tag) },
    { key: "expense_date", label: "Date", render: (r) => dateIN(r.expense_date) },
    { key: "amount", label: "Amount", align: "right", render: (r) => money(r.amount) },
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
    { key: "total", label: "Total", align: "right", render: (r) => money(r.total) },
    { key: "balance", label: "Balance", align: "right", render: (r) => money(r.balance) },
  ],
};

export function DrillDownModal({ metric, title, params, onClose }: DrillDownModalProps) {
  const qs = params ? `?${params}` : "";
  const { data, isLoading, error } = useQuery({
    queryKey: ["ceo-drill-down", metric, params ?? ""],
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
  const rows = data?.rows ?? [];

  return (
    <Modal isOpen onClose={onClose} title={title} size="xl">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <p className="text-sm text-rose-600 py-8 text-center">Couldn&apos;t load details.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 italic py-8 text-center">No records in this period.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-500">
              {rows.length} record{rows.length === 1 ? "" : "s"}
            </p>
            <p className="text-sm font-bold text-gray-900">
              Total: {formatINRExact(data?.total ?? 0)}
            </p>
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
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
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-gray-50">
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
        </div>
      )}
    </Modal>
  );
}
