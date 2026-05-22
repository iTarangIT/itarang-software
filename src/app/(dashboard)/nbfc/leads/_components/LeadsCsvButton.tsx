"use client";

/**
 * LeadsCsvButton — exports the current filtered + sorted lead list to CSV.
 *
 * The page passes the FULL filtered set (every row matching the active
 * filters, in the chosen sort order — not just the visible page), so the
 * download reflects exactly what the filters select. Generation is fully
 * client-side: a UTF-8 Blob (with BOM so Excel renders ₹ correctly).
 */
import { Download } from "lucide-react";
import type { LeadRow } from "./LeadsTable";

const COLUMNS: { header: string; value: (r: LeadRow) => string }[] = [
  { header: "Customer", value: (r) => r.full_name ?? "" },
  { header: "Loan ID", value: (r) => r.loan_application_id },
  { header: "Reference", value: (r) => r.reference_id ?? "" },
  { header: "Status", value: (r) => r.status },
  { header: "Dealer", value: (r) => r.dealer_name ?? "" },
  { header: "Battery Serial", value: (r) => r.battery_serial ?? "" },
  {
    header: "Loan Amount (INR)",
    value: (r) => (r.loan_amount != null ? String(r.loan_amount) : ""),
  },
  { header: "Loan File No.", value: (r) => r.loan_file_number ?? "" },
  { header: "Product", value: (r) => r.product_model ?? "" },
  {
    header: "CDS Score",
    value: (r) => (r.cds_score != null ? String(r.cds_score) : ""),
  },
  { header: "CDS Band", value: (r) => r.cds_band },
  {
    header: "Outstanding (INR)",
    value: (r) =>
      r.outstanding_amount != null ? String(r.outstanding_amount) : "",
  },
  {
    header: "Current DPD",
    value: (r) => (r.current_dpd != null ? String(r.current_dpd) : ""),
  },
  { header: "EMI Status", value: emiStatusText },
  { header: "City", value: (r) => r.city ?? "" },
  { header: "State", value: (r) => r.state ?? "" },
  {
    header: "Sanctioned",
    value: (r) =>
      r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : "",
  },
];

function emiStatusText(r: LeadRow): string {
  if (r.overdue_days != null && r.overdue_days > 0) {
    return `${r.overdue_days}d overdue`;
  }
  if (r.next_emi_date) {
    const d = new Date(r.next_emi_date);
    return Number.isNaN(d.getTime())
      ? ""
      : `Next ${d.toLocaleDateString("en-IN")}`;
  }
  return "";
}

/** RFC-4180 cell escaping. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function LeadsCsvButton({ rows }: { rows: LeadRow[] }) {
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
    a.download = `lead-intelligence-${new Date().toISOString().slice(0, 10)}.csv`;
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
      data-testid="leads-csv-download"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] transition hover:bg-[color:var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="h-4 w-4" />
      Download CSV ({rows.length})
    </button>
  );
}
