"use client";

/**
 * BatteriesCsvButton — exports the current filtered fleet list to CSV.
 *
 * The page passes the FULL filtered set (every battery matching the active
 * Status / Severity / Risk / Search filters — not just what is visible), so
 * the download reflects exactly what the filters select. Generation is fully
 * client-side: a UTF-8 Blob (with BOM so Excel renders °C correctly).
 */
import { Download } from "lucide-react";
import type { BatteryRow } from "./BatteriesTable";

const COLUMNS: { header: string; value: (r: BatteryRow) => string }[] = [
  { header: "Serial / Vehicle", value: (r) => r.vehicleno },
  { header: "Loan ID", value: (r) => r.loan_application_id },
  { header: "Borrower", value: (r) => r.borrower_name ?? "" },
  { header: "Freshness", value: (r) => r.freshness },
  {
    header: "SOC (%)",
    value: (r) => (r.soc_pct != null ? String(Math.round(r.soc_pct)) : ""),
  },
  {
    header: "SOH (%)",
    value: (r) => (r.soh_pct != null ? String(Math.round(r.soh_pct)) : ""),
  },
  {
    header: "Pack Temp (°C)",
    value: (r) =>
      r.pack_temp_c != null ? r.pack_temp_c.toFixed(1) : "",
  },
  {
    header: "CDS Score",
    value: (r) => (r.cds_score != null ? String(r.cds_score) : ""),
  },
  {
    header: "PCI Score",
    value: (r) => (r.pci_score != null ? String(r.pci_score) : ""),
  },
  { header: "Confidence", value: (r) => r.confidence ?? "" },
  { header: "Open Alerts", value: (r) => String(r.open_alerts) },
  {
    header: "Last Seen",
    value: (r) =>
      r.last_seen ? new Date(r.last_seen).toLocaleString("en-IN") : "",
  },
];

/** RFC-4180 cell escaping. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function BatteriesCsvButton({ rows }: { rows: BatteryRow[] }) {
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
    a.download = `battery-monitoring-${new Date().toISOString().slice(0, 10)}.csv`;
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
      data-testid="batteries-csv-download"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] transition hover:bg-[color:var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="h-4 w-4" />
      Download CSV ({rows.length})
    </button>
  );
}
