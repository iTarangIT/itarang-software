/**
 * Scrap / Buyback daily digest — the pure half (no db, no I/O, unit tested).
 *
 * The descriptor (./scrap-buyback.ts) runs the SQL and hands the raw numbers
 * here; this file turns them into ActivityLine / BacklogLine lists and detail
 * rows. Split out so the line shapes — which the mail, the xlsx and the
 * `digest_runs.counts` blob all read — can be tested without a database.
 *
 * TWO FLOWS, NEVER MIXED. Every line carries `sheet`: SCRAP_SHEET for NBFC
 * scrap consignments (scrap_consignments), BUYBACK_SHEET for the dealer buyback
 * pipeline (buyback_requests / buyback_deals / settlement_transactions). NBFC
 * customer buyback (nbfc_buyback_requests), auction_* and refurbishment_* are
 * out of scope for this report.
 *
 * LABELS ARE UNIQUE ACROSS THE WHOLE DIGEST — the engine flattens figures into
 * `counts` keyed by label, so two lines called "batteries" would overwrite each
 * other. Every label is therefore prefixed with its flow.
 */

import { STAGE_BUCKETS, stageForStatus } from "@/lib/buyback/flow";

import type { ActivityLine, BacklogLine, DigestDetailRow, DigestFigures } from "../types";

export const SCRAP_SHEET = "Scrap (NBFC consignments)";
export const BUYBACK_SHEET = "Dealer Buyback";

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** "₹1,25,000" — Indian grouping, whole rupees. */
export function inr(v: unknown): string {
  return `₹${Math.round(num(v)).toLocaleString("en-IN")}`;
}

/** "VENDOR_AGREED" → "Vendor agreed". */
export function humanStatus(status: string): string {
  const s = status.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type ScrapDayCounts = {
  submitted: number;
  submitted_batteries: number;
  submitted_asking: number;
  agreed: number;
  agreed_batteries: number;
  agreed_amount: number;
  paid: number;
  paid_amount: number;
  rejected: number;
  withdrawn: number;
  nbfcs_active: number;
  open_draft: number;
  open_submitted: number;
  open_negotiating: number;
  open_agreed: number;
  open_agreed_unpaid_amount: number;
  open_batteries: number;
  oldest_open_days: number | null;
};

export type BuybackDayCounts = {
  requests: number;
  requests_web: number;
  requests_whatsapp: number;
  requests_csv: number;
  moved_deals: number;
  /** Deals that entered each status on the day. */
  moves: Array<{ status: string; deals: number }>;
  settle_txns: number;
  received: number;
  paid_out: number;
  margin_locked: number;
  margin_closed: number;
  /** Open (non-draft, non-terminal) deals by current status. */
  open_by_status: Array<{ status: string; deals: number; value: number }>;
  idle_over_7: number;
  idle_over_30: number;
  oldest_idle_days: number | null;
};

/** Enum order, so "moved into" lines read in pipeline order. */
const DEAL_STATUS_ORDER = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
  "VENDOR_AGREED",
  "DEALER_REOPENED",
  "PO_EXCHANGED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "INVOICE_RAISED",
  "INVOICE_APPROVED",
  "SETTLED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
];

function statusRank(s: string): number {
  const i = DEAL_STATUS_ORDER.indexOf(s);
  return i < 0 ? DEAL_STATUS_ORDER.length : i;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export function scrapFigures(c: ScrapDayCounts): { activity: ActivityLine[]; backlog: BacklogLine[] } {
  const S = SCRAP_SHEET;
  const activity: ActivityLine[] = [
    { key: "scrapSubmitted", label: "Scrap · consignments submitted", value: c.submitted, bucket: "scrapSubmitted", sheet: S },
    { key: "scrapSubmitted", label: "Scrap · batteries submitted", value: c.submitted_batteries, indent: true, sheet: S },
    {
      key: "scrapSubmitted",
      label: "Scrap · asking amount",
      value: c.submitted_asking,
      display: inr(c.submitted_asking),
      indent: true,
      sheet: S,
    },
    { key: "scrapAgreed", label: "Scrap · rates agreed", value: c.agreed, bucket: "scrapAgreed", sheet: S },
    { key: "scrapAgreed", label: "Scrap · batteries agreed", value: c.agreed_batteries, indent: true, sheet: S },
    {
      key: "scrapAgreed",
      label: "Scrap · agreed amount",
      value: c.agreed_amount,
      display: inr(c.agreed_amount),
      indent: true,
      sheet: S,
    },
    { key: "scrapPaid", label: "Scrap · consignments paid", value: c.paid, bucket: "scrapPaid", sheet: S },
    {
      key: "scrapPaid",
      label: "Scrap · amount paid out",
      value: c.paid_amount,
      display: inr(c.paid_amount),
      indent: true,
      sheet: S,
    },
    { key: "scrapRejected", label: "Scrap · rejected", value: c.rejected, bucket: "scrapRejected", sheet: S },
    { key: "scrapRejected", label: "Scrap · withdrawn by NBFC", value: c.withdrawn, bucket: "scrapWithdrawn", sheet: S },
    { key: "scrapByNbfc", label: "Scrap · NBFCs with activity", value: c.nbfcs_active, bucket: "scrapByNbfc", sheet: S },
  ];

  const backlog: BacklogLine[] = [
    { key: "scrapBacklog", label: "Scrap open · awaiting iTarang response (submitted)", value: c.open_submitted, sheet: S },
    { key: "scrapBacklog", label: "Scrap open · negotiating", value: c.open_negotiating, sheet: S },
    { key: "scrapBacklog", label: "Scrap open · agreed, awaiting payment", value: c.open_agreed, sheet: S },
    {
      key: "scrapBacklog",
      label: "Scrap open · agreed amount unpaid",
      value: c.open_agreed_unpaid_amount,
      display: inr(c.open_agreed_unpaid_amount),
      sheet: S,
    },
    { key: "scrapBacklog", label: "Scrap open · batteries committed", value: c.open_batteries, sheet: S },
    { key: "scrapBacklog", label: "Scrap · NBFC drafts not yet submitted", value: c.open_draft, sheet: S },
    {
      key: "scrapBacklog",
      label: "Scrap · oldest open consignment",
      value: c.oldest_open_days ?? 0,
      display: c.oldest_open_days == null ? "none open" : `${c.oldest_open_days} days`,
      sheet: S,
    },
  ];

  return { activity, backlog };
}

export function buybackFigures(c: BuybackDayCounts): { activity: ActivityLine[]; backlog: BacklogLine[] } {
  const B = BUYBACK_SHEET;

  const activity: ActivityLine[] = [
    { key: "buybackRequests", label: "Buyback · new dealer requests", value: c.requests, bucket: "buybackRequests", sheet: B },
    { key: "buybackRequests", label: "Buyback · via web", value: c.requests_web, indent: true, sheet: B },
    { key: "buybackRequests", label: "Buyback · via WhatsApp", value: c.requests_whatsapp, indent: true, sheet: B },
    { key: "buybackRequests", label: "Buyback · via CSV", value: c.requests_csv, indent: true, sheet: B },
    { key: "buybackMoves", label: "Buyback · deals that changed status", value: c.moved_deals, bucket: "buybackMoves", sheet: B },
    ...[...c.moves]
      .filter((m) => m.deals > 0)
      .sort((a, b) => statusRank(a.status) - statusRank(b.status))
      .map<ActivityLine>((m) => ({
        key: "buybackMoves",
        label: `Buyback · moved to ${humanStatus(m.status)}`,
        value: m.deals,
        indent: true,
        sheet: B,
      })),
    {
      key: "buybackSettlement",
      label: "Buyback · settlement transactions",
      value: c.settle_txns,
      bucket: "buybackSettlements",
      sheet: B,
    },
    {
      key: "buybackSettlement",
      label: "Buyback · received from vendors",
      value: c.received,
      display: inr(c.received),
      indent: true,
      sheet: B,
    },
    {
      key: "buybackSettlement",
      label: "Buyback · paid to dealers",
      value: c.paid_out,
      display: inr(c.paid_out),
      indent: true,
      sheet: B,
    },
    {
      key: "buybackMargin",
      label: "Buyback · margin locked",
      value: c.margin_locked,
      display: inr(c.margin_locked),
      sheet: B,
    },
    {
      key: "buybackMargin",
      label: "Buyback · margin earned on deals closed",
      value: c.margin_closed,
      display: inr(c.margin_closed),
      sheet: B,
    },
  ];

  // Open pipeline folded into the same five stages as the buyback dashboard's
  // funnel (STAGE_BUCKETS), so the mail and /admin/buyback/dashboard agree.
  // Statuses outside every stage (DRAFT, DEALER_REOPENED, terminal) are dropped,
  // exactly as the dashboard drops them. CLOSED is terminal, so the "Settled"
  // stage here counts SETTLED deals not yet closed.
  const stage = new Map<string, { deals: number; value: number }>(
    STAGE_BUCKETS.map((b) => [b.key, { deals: 0, value: 0 }]),
  );
  for (const r of c.open_by_status) {
    const key = stageForStatus(r.status);
    if (!key) continue;
    const s = stage.get(key)!;
    s.deals += r.deals;
    s.value += r.value;
  }
  const totalValue = [...stage.values()].reduce((a, s) => a + s.value, 0);

  const backlog: BacklogLine[] = [
    ...STAGE_BUCKETS.map<BacklogLine>((b) => ({
      key: "buybackBacklog",
      label: `Buyback open · ${b.label}`,
      value: stage.get(b.key)!.deals,
      sheet: B,
    })),
    {
      key: "buybackBacklog",
      label: "Buyback open · value at stake (locked dealer price)",
      value: totalValue,
      display: inr(totalValue),
      sheet: B,
    },
    { key: "buybackAging", label: "Buyback · open deals idle > 7 days", value: c.idle_over_7, sheet: B },
    { key: "buybackAging", label: "Buyback · open deals idle > 30 days", value: c.idle_over_30, sheet: B },
    {
      key: "buybackAging",
      label: "Buyback · longest idle open deal",
      value: c.oldest_idle_days ?? 0,
      display: c.oldest_idle_days == null ? "none open" : `${c.oldest_idle_days} days`,
      sheet: B,
    },
  ];

  return { activity, backlog };
}

export function scrapBuybackFigures(scrap: ScrapDayCounts, buyback: BuybackDayCounts): DigestFigures {
  const s = scrapFigures(scrap);
  const b = buybackFigures(buyback);
  return { activity: [...s.activity, ...b.activity], backlog: [...s.backlog, ...b.backlog] };
}

// ---------------------------------------------------------------------------
// Detail rows
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return v == null || v === "" ? null : String(v);
}

function arr(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

/** A consignment behind a scrap bucket. `amount` is whichever figure the bucket is about. */
export function scrapConsignmentRows(raw: unknown, amountLabel: string): DigestDetailRow[] {
  return arr(raw).map((o) => ({
    id: String(o.id ?? ""),
    title: str(o.ref_code) ?? "—",
    subtitle:
      [
        str(o.nbfc),
        `${num(o.battery_count)} batteries`,
        o.amount == null ? null : `${amountLabel} ${inr(o.amount)}`,
      ]
        .filter(Boolean)
        .join(" · ") || null,
    city: str(o.city),
    state: str(o.state),
    source: str(o.nbfc),
    at: str(o.at),
  }));
}

/** One row per NBFC: what that NBFC's scrap consignments did on the day. */
export function scrapNbfcRows(raw: unknown): DigestDetailRow[] {
  return arr(raw).map((o) => {
    const parts = [
      `submitted ${num(o.submitted)} (${num(o.batteries)} batteries, asking ${inr(o.asking)})`,
      `agreed ${num(o.agreed)} (${inr(o.agreed_amount)})`,
      `paid ${num(o.paid)} (${inr(o.paid_amount)})`,
      `rejected ${num(o.rejected)}`,
    ];
    if (num(o.withdrawn) > 0) parts.push(`withdrawn ${num(o.withdrawn)}`);
    return {
      id: String(o.tenant_id ?? ""),
      title: str(o.nbfc) ?? "Unknown NBFC",
      subtitle: parts.join(" · "),
      city: null,
      state: null,
      source: null,
      at: null,
    };
  });
}

export function buybackRequestRows(raw: unknown): DigestDetailRow[] {
  return arr(raw).map((o) => ({
    id: String(o.id ?? ""),
    title: str(o.request_no) ?? "—",
    subtitle: str(o.dealer),
    city: str(o.city),
    state: str(o.state),
    source: str(o.source_channel),
    at: str(o.at),
  }));
}

export function buybackMoveRows(raw: unknown): DigestDetailRow[] {
  return arr(raw).map((o) => {
    const from = str(o.from_status);
    const to = str(o.to_status) ?? "—";
    const move = from ? `${humanStatus(from)} → ${humanStatus(to)}` : `→ ${humanStatus(to)}`;
    return {
      id: String(o.deal_id ?? ""),
      title: str(o.request_no) ?? "—",
      subtitle: [str(o.dealer), move].filter(Boolean).join(" · "),
      city: str(o.city),
      state: str(o.state),
      source: str(o.role),
      at: str(o.at),
    };
  });
}

export function buybackSettlementRows(raw: unknown): DigestDetailRow[] {
  return arr(raw).map((o) => {
    const dir = String(o.direction ?? "") === "IN" ? "received" : "paid";
    return {
      id: String(o.id ?? ""),
      title: str(o.request_no) ?? "—",
      subtitle: [str(o.dealer), `${str(o.leg) ?? "—"} ${dir} ${inr(o.amount)}`, str(o.txn_ref)]
        .filter(Boolean)
        .join(" · "),
      city: null,
      state: null,
      source: str(o.method),
      at: str(o.at),
    };
  });
}
