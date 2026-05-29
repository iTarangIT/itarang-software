"use client";

/**
 * E-118 — Buyback requests table (BRD §6.1.7 Recovery & Auction)
 *
 * Read-only seller-tenant view of customer battery-buyback requests, rendered
 * through the shared ResponsiveTable primitive (desktop table / mobile cards).
 */
import ResponsiveTable, {
  type ResponsiveColumn,
} from "./ResponsiveTable";

export type BuybackRow = {
  id: string;
  customer_name: string;
  battery_serial: string;
  soh_percent: number | null;
  requested_at: string;
  evaluation_status: string;
  offer_amount: number | null;
  status: string;
};

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN");
}

// Request lifecycle → status-pill tone.
const STATUS_TONE: Record<string, string> = {
  accepted: "status-pill-success",
  offer_made: "status-pill-info",
  pending_evaluation: "status-pill-warning",
  rejected: "status-pill-neutral",
};

// Evaluation progress → status-pill tone.
const EVAL_TONE: Record<string, string> = {
  completed: "status-pill-success",
  in_review: "status-pill-info",
  pending: "status-pill-neutral",
};

function prettify(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function Pill({ value, tone }: { value: string; tone: string }) {
  return (
    <span className={`status-pill ${tone}`}>{prettify(value)}</span>
  );
}

const COLUMNS: ResponsiveColumn<BuybackRow>[] = [
  {
    key: "customer",
    header: "Customer",
    mobile: "primary",
    render: (r) => (
      <span className="font-semibold text-[color:var(--color-ink)]">
        {r.customer_name}
      </span>
    ),
  },
  {
    key: "battery",
    header: "Battery",
    render: (r) => (
      <span className="font-mono text-xs">{r.battery_serial}</span>
    ),
  },
  {
    key: "soh",
    header: "SOH",
    align: "right",
    render: (r) => (
      <span className="tabular-nums">
        {r.soh_percent != null ? `${r.soh_percent}%` : "—"}
      </span>
    ),
  },
  {
    key: "requested",
    header: "Requested",
    render: (r) => (
      <span className="tabular-nums text-[color:var(--color-ink-muted)]">
        {fmtDate(r.requested_at)}
      </span>
    ),
  },
  {
    key: "evaluation",
    header: "Evaluation",
    render: (r) => (
      <Pill
        value={r.evaluation_status}
        tone={EVAL_TONE[r.evaluation_status] ?? "status-pill-neutral"}
      />
    ),
  },
  {
    key: "offer",
    header: "Offer",
    align: "right",
    render: (r) => (
      <span className="tabular-nums">
        {r.offer_amount != null ? fmtINR(r.offer_amount) : "—"}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    mobile: "primary",
    align: "right",
    render: (r) => (
      <Pill
        value={r.status}
        tone={STATUS_TONE[r.status] ?? "status-pill-neutral"}
      />
    ),
  },
];

export function BuybackRequestsTable({ rows }: { rows: BuybackRow[] }) {
  return (
    <ResponsiveTable
      columns={COLUMNS}
      rows={rows}
      rowKey={(r) => r.id}
      emptyMessage="No buyback requests."
      caption="Customer battery buyback requests"
    />
  );
}
