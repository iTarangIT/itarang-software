"use client";

/**
 * BatteriesTable — fleet telemetry list (BRD §6.2).
 *
 * Renders the battery fleet through the responsive table primitive
 * (desktop table / mobile card-stack). CDS / PCI cells are clickable
 * ScoreBadges that open the §6.4.5 explainability drawer. Tapping a row
 * navigates to ?serial=<vehicleno>, which the server page expands into the
 * per-battery detail drawer.
 */
import { useRouter, useSearchParams } from "next/navigation";
import ResponsiveTable, {
  type ResponsiveColumn,
} from "@/components/nbfc-portal/ResponsiveTable";
import ScoreBadge from "@/components/nbfc-portal/ScoreBadge";

export type BatteryRow = {
  vehicleno: string;
  loan_application_id: string;
  borrower_name: string | null;
  soc_pct: number | null;
  soh_pct: number | null;
  pack_temp_c: number | null;
  cds_score: number | null;
  pci_score: number | null;
  confidence: string | null;
  last_seen: string | null;
  freshness: string;
  open_alerts: number;
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

export default function BatteriesTable({
  rows,
  bands,
}: {
  rows: BatteryRow[];
  bands: Bands;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const thresholds = { cdsWarning: bands.low_mid, cdsHigh: bands.mid_high };

  function openRow(r: BatteryRow) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("serial", r.vehicleno);
    router.push(`/nbfc/batteries?${next.toString()}`, { scroll: false });
  }

  const columns: ResponsiveColumn<BatteryRow>[] = [
    {
      key: "serial",
      header: "Serial / Vehicle",
      mobile: "primary",
      render: (r) => (
        <span className="font-mono text-xs font-semibold">{r.vehicleno}</span>
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
      key: "borrower",
      header: "Borrower",
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
      key: "soc",
      header: "SOC",
      align: "right",
      render: (r) => (
        <span className="tabular-nums">
          {r.soc_pct != null ? `${Math.round(r.soc_pct)}%` : "—"}
        </span>
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
      key: "temp",
      header: "Temp",
      align: "right",
      mobile: "hidden",
      render: (r) => (
        <span className="tabular-nums">
          {r.pack_temp_c != null ? `${r.pack_temp_c.toFixed(0)}°C` : "—"}
        </span>
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
      key: "last_seen",
      header: "Last seen",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs text-[color:var(--color-ink-muted)] tabular-nums">
          {r.last_seen ? new Date(r.last_seen).toLocaleString("en-IN") : "—"}
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
    <ResponsiveTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.vehicleno}
      onRowClick={openRow}
      emptyMessage="No batteries match these filters."
      caption="Fleet telemetry"
    />
  );
}
