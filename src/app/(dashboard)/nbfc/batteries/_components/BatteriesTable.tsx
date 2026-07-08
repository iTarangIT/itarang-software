"use client";

/**
 * BatteriesTable — fleet telemetry list (BRD §6.2).
 *
 * Renders the battery fleet through the responsive table primitive
 * (desktop table / mobile card-stack). CDS / PCI cells are clickable
 * ScoreBadges that open the §6.4.5 explainability drawer. Tapping a row
 * opens the right-side CaseWorkspaceSheet (BRD §6.4.5 / §6.1.6) — used to
 * replace the previous ?serial= inline drawer flow.
 */
import { useState } from "react";
import ResponsiveTable, {
  type ResponsiveColumn,
} from "@/components/nbfc-portal/ResponsiveTable";
import ScoreBadge from "@/components/nbfc-portal/ScoreBadge";
import CaseWorkspaceSheet from "./CaseWorkspaceSheet";

export type BatteryRow = {
  vehicleno: string;
  loan_application_id: string;
  borrower_name: string | null;
  dealer_name: string | null;
  city: string | null;
  imei: string | null;
  emi_amount: number | null;
  current_dpd: number | null;
  soc_pct: number | null;
  soh_pct: number | null;
  pack_temp_c: number | null;
  cds_score: number | null;
  pci_score: number | null;
  confidence: string | null;
  last_seen: string | null;
  freshness: string;
  open_alerts: number;
  last_action_badge: string | null;
};

type Bands = { low_mid: number; mid_high: number };

const FRESHNESS_TONE: Record<string, string> = {
  fresh: "status-pill-success",
  idle: "status-pill-warning",
  stale: "status-pill-warning",
  offline: "status-pill-danger",
  never: "status-pill-neutral",
};

function FreshnessPill({ value }: { value: string }) {
  return (
    <span
      className={`status-pill ${FRESHNESS_TONE[value] ?? "status-pill-neutral"} capitalize`}
    >
      {value}
    </span>
  );
}

function confidenceTone(c: string | null): string {
  const v = (c ?? "").toUpperCase();
  if (v === "HIGH") return "text-[color:var(--color-success)]";
  if (v === "MEDIUM") return "text-[color:var(--color-warning)]";
  return "text-[color:var(--color-ink-muted)]";
}

function RiskBadge({ cds, bands }: { cds: number | null; bands: Bands }) {
  if (cds == null) {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-500">
        —
      </span>
    );
  }
  // Band on the ROUNDED score — the same integer the CDS cell displays — so a
  // battery shown as "40" always reads Medium, never Low (a raw 39.53 that
  // rounds up to 40 must land in the band its number implies).
  const v = Math.round(cds);
  if (v >= 85) {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
        Very High
      </span>
    );
  }
  if (v >= bands.mid_high) {
    return (
      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase text-orange-700">
        High
      </span>
    );
  }
  if (v >= bands.low_mid) {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">
        Medium
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
      Low
    </span>
  );
}

export default function BatteriesTable({
  rows,
  bands,
}: {
  rows: BatteryRow[];
  bands: Bands;
}) {
  const [sheetRow, setSheetRow] = useState<BatteryRow | null>(null);
  const thresholds = { cdsWarning: bands.low_mid, cdsHigh: bands.mid_high };

  const columns: ResponsiveColumn<BatteryRow>[] = [
    {
      key: "battery",
      header: "Battery",
      mobile: "primary",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold">{r.vehicleno}</div>
          {r.last_action_badge ? (
            <span className="mt-1 inline-block rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-red-700">
              {r.last_action_badge}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "imei",
      header: "IMEI",
      mobile: "hidden",
      render: (r) => (
        <span className="font-mono text-[11px] text-[color:var(--color-ink-muted)]">
          {r.imei ?? "—"}
        </span>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.borrower_name ?? "—"}</div>
          <div className="truncate text-[11px] text-[color:var(--color-ink-muted)]">
            {r.loan_application_id}
          </div>
        </div>
      ),
    },
    {
      key: "dealer",
      header: "Dealer",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs">{r.dealer_name ?? "—"}</span>
      ),
    },
    {
      key: "soh",
      header: "SOH",
      align: "right",
      render: (r) => (
        <span className="tabular-nums">
          {r.soh_pct != null ? `${Math.round(r.soh_pct)}%` : "—"}
        </span>
      ),
    },
    {
      key: "emi",
      header: "EMI",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs tabular-nums">
          {(r.current_dpd ?? 0) > 0 ? (
            <span className="text-amber-700">{r.current_dpd}d overdue</span>
          ) : (
            <span className="text-emerald-700">On time</span>
          )}
        </span>
      ),
    },
    {
      key: "dpd",
      header: "DPD",
      align: "right",
      mobile: "hidden",
      render: (r) => (
        <span className="tabular-nums">{r.current_dpd ?? 0}</span>
      ),
    },
    {
      key: "cds",
      header: "CDS",
      render: (r) => (
        <ScoreBadge
          type="cds"
          value={r.cds_score}
          loanSanctionId={r.loan_application_id}
          thresholds={thresholds}
        />
      ),
    },
    {
      key: "pci",
      header: "PCI",
      render: (r) => (
        <ScoreBadge
          type="pci"
          value={r.pci_score}
          loanSanctionId={r.loan_application_id}
        />
      ),
    },
    {
      key: "risk",
      header: "Risk",
      mobile: "hidden",
      render: (r) => <RiskBadge cds={r.cds_score} bands={bands} />,
    },
    {
      key: "geo",
      header: "Geo",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs text-[color:var(--color-ink-muted)]">
          {r.city ?? "—"}
        </span>
      ),
    },
    {
      key: "freshness",
      header: "Freshness",
      mobile: "primary",
      align: "right",
      render: (r) => <FreshnessPill value={r.freshness} />,
    },
    {
      key: "confidence",
      header: "Conf.",
      mobile: "hidden",
      render: (r) => (
        <span
          className={`text-[10px] font-bold uppercase tracking-widest ${confidenceTone(
            r.confidence,
          )}`}
        >
          {r.confidence ?? "—"}
        </span>
      ),
    },
    {
      key: "alerts",
      header: "Alerts",
      align: "right",
      render: (r) =>
        r.open_alerts > 0 ? (
          <span className="status-pill status-pill-danger tabular-nums">
            {r.open_alerts}
          </span>
        ) : (
          <span className="text-[color:var(--color-ink-muted)]">0</span>
        ),
    },
  ];

  return (
    <>
      <ResponsiveTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.vehicleno}
        onRowClick={(r) => setSheetRow(r)}
        emptyMessage="No batteries match these filters."
        caption="Battery risk master table"
      />
      <CaseWorkspaceSheet
        open={sheetRow !== null}
        loanSanctionId={sheetRow?.loan_application_id ?? null}
        batteryCode={sheetRow?.vehicleno ?? null}
        bands={bands}
        onClose={() => setSheetRow(null)}
      />
    </>
  );
}
