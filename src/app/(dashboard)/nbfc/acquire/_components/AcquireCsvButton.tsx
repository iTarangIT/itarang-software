"use client";

/**
 * AcquireCsvButton — exports the current filtered + sorted Acquire pipeline to
 * CSV. The page passes the FULL filtered set (every row matching the active
 * filters, in the chosen sort order — not just the visible page), so the
 * download reflects exactly what the filters select. Generation is client-side:
 * a UTF-8 Blob (with BOM so Excel renders ₹ correctly). Mirrors the Lead
 * Intelligence `LeadsCsvButton` pattern.
 */
import { Download } from "lucide-react";

export type AcquireRow = {
  assignment_id: string;
  assignment_status: string;
  assigned_at: string | null;
  lead_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  state: string | null;
  city: string | null;
  resident_status: string | null;
  final_price: number | null;
  dealer_code: string | null;
  dealer_name: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  offer_submitted: "Offer submitted",
  selected: "Selected",
  not_selected: "Not selected",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const COLUMNS: { header: string; value: (r: AcquireRow) => string }[] = [
  { header: "Lead ID", value: (r) => r.lead_id },
  { header: "Customer", value: (r) => r.customer_name ?? "" },
  { header: "Phone", value: (r) => r.customer_phone ?? "" },
  { header: "City", value: (r) => r.city ?? "" },
  { header: "State", value: (r) => r.state ?? "" },
  { header: "Residence", value: (r) => r.resident_status ?? "" },
  {
    header: "Asset Price (INR)",
    value: (r) => (r.final_price != null ? String(r.final_price) : ""),
  },
  { header: "Dealer", value: (r) => r.dealer_name ?? "" },
  { header: "Dealer Code", value: (r) => r.dealer_code ?? "" },
  {
    header: "Status",
    value: (r) => STATUS_LABEL[r.assignment_status] ?? r.assignment_status,
  },
  {
    header: "Assigned",
    value: (r) =>
      r.assigned_at ? new Date(r.assigned_at).toLocaleDateString("en-IN") : "",
  },
];

/** RFC-4180 cell escaping. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function AcquireCsvButton({ rows }: { rows: AcquireRow[] }) {
  function download() {
    if (rows.length === 0) return;
    const lines = [
      COLUMNS.map((c) => csvCell(c.header)).join(","),
      ...rows.map((r) => COLUMNS.map((c) => csvCell(c.value(r))).join(",")),
    ];
    // Leading BOM so Excel reads it as UTF-8.
    const csv = "﻿" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `acquire-pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={rows.length === 0}
      data-testid="acquire-csv-download"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="h-4 w-4" />
      Download CSV ({rows.length})
    </button>
  );
}
