/**
 * Money-leg reads and the two amounts everything else is checked against (M12–M14).
 *
 * THE RULE THAT MATTERS: both settlement amounts are derived from
 * `deal_line_locks`, server-side. Neither the dealer nor an admin states them.
 * The dealer is paid Σ qty × dealer_price; the vendor pays Σ qty × vendor_price;
 * the difference IS the margin. That is what makes M14's reconciliation invariant
 * — "ledger net for CLOSED deals == dashboard Total Margin Earned" — true by
 * construction rather than by luck.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { formatBatteryLine } from "./format";
import type { LockedLine } from "./invoice-match";
import type { BuybackTx } from "./tx";

/** 'BB-1024' → 'TXN-1024'. The pair; each leg hangs off it as -D / -V. */
export function groupTxnId(requestNo: string): string {
  return `TXN-${requestNo.replace(/^BB-/, "")}`;
}

export function legSubId(requestNo: string, leg: "DEALER" | "VENDOR"): string {
  return `${groupTxnId(requestNo)}-${leg === "DEALER" ? "D" : "V"}`;
}

export interface DealMoney {
  line_id: string;
  quantity: number;
  /** "60V 120Ah · Working ×3" — for humans. */
  label: string;
  /** "60V 120Ah" — for documents, which put the condition in its own column. */
  spec_label: string;
  condition: "WORKING" | "DEAD";
  condition_label: string;
  dealer_price: number;
  vendor_price: number | null;
  margin_value: number;
}

/**
 * The deal's economics, one row per SKU, from the CURRENT lock generation.
 *
 * vendor_price is null until a vendor agrees; everything downstream that needs it
 * (the vendor invoice, the receipt amount) checks.
 */
export async function dealMoney(
  dealId: string,
  runner: BuybackTx | typeof db = db,
): Promise<DealMoney[]> {
  const rows = await runner.execute(sql`
    SELECT
      dll.line_id, dll.dealer_price, dll.vendor_price, dll.margin_value,
      bl.quantity, bl.condition,
      cv.voltage, cv.ah
    FROM deal_line_locks dll
    JOIN buyback_deals bd ON bd.id = dll.deal_id
                         AND bd.offer_version = dll.offer_version
    JOIN buyback_lines bl ON bl.id = dll.line_id
    JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE dll.deal_id = ${dealId}
    ORDER BY cv.voltage, cv.ah
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const f = formatBatteryLine({
      id: String(r.line_id),
      quantity: Number(r.quantity),
      condition: r.condition as "WORKING" | "DEAD",
      voltage: r.voltage as string,
      ah: r.ah as string,
    });

    return {
      line_id: String(r.line_id),
      quantity: Number(r.quantity),
      label: f.full,
      spec_label: f.specLabel,
      condition: r.condition as "WORKING" | "DEAD",
      condition_label: f.condition,
      dealer_price: Number(r.dealer_price),
      vendor_price: r.vendor_price === null ? null : Number(r.vendor_price),
      margin_value: Number(r.margin_value),
    };
  });
}

/** What the invoice-match function compares against. */
export function toLockedLines(money: DealMoney[]): LockedLine[] {
  return money.map((m) => ({
    line_id: m.line_id,
    quantity: m.quantity,
    dealer_price: m.dealer_price,
    label: m.label,
  }));
}

/** What iTarang owes the dealer. Never taken from the client. */
export function dealerPayout(money: DealMoney[]): number {
  return money.reduce((s, m) => s + m.quantity * m.dealer_price, 0);
}

/** What the vendor owes iTarang. Null if no vendor has agreed yet. */
export function vendorReceipt(money: DealMoney[]): number | null {
  if (money.some((m) => m.vendor_price === null)) return null;
  return money.reduce((s, m) => s + m.quantity * (m.vendor_price ?? 0), 0);
}

/**
 * What we PLANNED to earn: Σ qty × margin_value, the uplift we added to the
 * dealer's price when setting the ask.
 *
 * This is NOT what the ledger reconciles against — see realisedMargin.
 */
export function plannedMargin(money: DealMoney[]): number {
  return money.reduce((s, m) => s + m.quantity * m.margin_value, 0);
}

/**
 * What we ACTUALLY earned: Σ qty × (vendor_price − dealer_price).
 *
 * THIS is the number M14 reconciles the ledger against, and the distinction is
 * not academic. `margin_value` is the uplift we *asked* for. The vendor may agree
 * ABOVE the ask — haggle them up ₹50/unit and the realised margin exceeds the
 * planned one. (It can never fall below: the floor guard refuses any agreement
 * under Σ qty × (dealer_price + margin_value).)
 *
 * Reconciling the ledger against the PLANNED margin would therefore:
 *   · make every dashboard understate what iTarang actually earned, and
 *   · make close_deal refuse to close perfectly good deals, because the money
 *     that really moved would "fail" a check against a number it was never
 *     supposed to equal.
 *
 * Returns null until a vendor has agreed — there is no realised margin before
 * there is a sale.
 */
export function realisedMargin(money: DealMoney[]): number | null {
  if (money.some((m) => m.vendor_price === null)) return null;
  return money.reduce((s, m) => s + m.quantity * ((m.vendor_price ?? 0) - m.dealer_price), 0);
}

export interface InvoiceRow {
  id: string;
  leg: "DEALER" | "VENDOR";
  raised_by_party: "DEALER" | "ITARANG";
  number: string;
  status: "RAISED" | "APPROVED" | "RETURNED";
  pdf_s3: string | null;
  returned_reason: string | null;
  created_at: Date;
  lines: Array<{
    line_id: string;
    quantity: number;
    price_per_unit: string;
    matched: boolean | null;
  }>;
}

/** Every invoice on a deal, newest first — including the returned ones. */
export async function invoicesForDeal(
  dealId: string,
  runner: BuybackTx | typeof db = db,
): Promise<InvoiceRow[]> {
  const rows = await runner.execute(sql`
    SELECT
      i.id, i.leg, i.raised_by_party, i.number, i.status, i.pdf_s3,
      i.returned_reason, i.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'line_id', il.line_id, 'quantity', il.quantity,
            'price_per_unit', il.price_per_unit, 'matched', il.matched
          ) ORDER BY il.created_at
        ) FILTER (WHERE il.id IS NOT NULL), '[]'
      ) AS lines
    FROM invoices i
    LEFT JOIN invoice_lines il ON il.invoice_id = i.id
    WHERE i.deal_id = ${dealId}
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `);

  return rows as unknown as InvoiceRow[];
}

/** The LIVE invoice on a leg (i.e. not one that was returned), if any. */
export async function liveInvoice(
  dealId: string,
  leg: "DEALER" | "VENDOR",
  runner: BuybackTx | typeof db = db,
): Promise<InvoiceRow | null> {
  const all = await invoicesForDeal(dealId, runner);
  return all.find((i) => i.leg === leg && i.status !== "RETURNED") ?? null;
}

export interface SettlementRow {
  id: string;
  leg: "DEALER" | "VENDOR";
  leg_sub_id: string;
  direction: "OUT" | "IN";
  method: "MANUAL" | "STATEMENT" | "API";
  txn_ref: string | null;
  amount: string;
  txn_date: string;
  proof_s3: string | null;
  closed_at: Date | null;
}

export async function settlementsForDeal(
  dealId: string,
  runner: BuybackTx | typeof db = db,
): Promise<SettlementRow[]> {
  const rows = await runner.execute(sql`
    SELECT id, leg, leg_sub_id, direction, method, txn_ref, amount, txn_date,
           proof_s3, closed_at
    FROM settlement_transactions
    WHERE deal_id = ${dealId}
    ORDER BY created_at
  `);
  return rows as unknown as SettlementRow[];
}

/**
 * Ext-9 — the dealer list's payout summary, BATCHED for one dealer entity and
 * keyed by request id, so GET /api/buyback/requests does not run one
 * dealMoney() per row.
 *
 * Lives HERE, not in the route, for the same reason dealMoney does: the
 * permissions contract test forbids a dealer-facing route file from so much as
 * mentioning the locks or settlement tables. The route sees only this Map and
 * feeds it through toDealerPayout(), which is where the redaction contract is
 * enforced (and contract-tested).
 *
 * Two deliberate scopings:
 *  · the locked total is Σ qty × dealer_price over the CURRENT lock generation
 *    (bd.offer_version = dll.offer_version), exactly like dealMoney — and the
 *    vendor_price/margin_value columns are never selected;
 *  · only DEALER-leg settlement rows are selected (WHERE leg = 'DEALER').
 *    toDealerPayout() filters by leg again regardless — two independent
 *    barriers, same as toVendorLine.
 *
 * A request with no lock rows has no entry, so its payout serializes to null —
 * the deal has not reached the money stage.
 */
export async function dealerPayoutSourcesForEntity(
  entityId: string,
): Promise<Map<string, { locked_dealer_total: number; settlements: Array<{ leg: string; txn_ref: string | null }> }>> {
  const lockRows = await db.execute(sql`
    SELECT bd.request_id, sum(bl.quantity * dll.dealer_price)::float8 AS locked_dealer_total
    FROM deal_line_locks dll
    JOIN buyback_deals bd    ON bd.id = dll.deal_id
                            AND bd.offer_version = dll.offer_version
    JOIN buyback_requests br ON br.id = bd.request_id
    JOIN buyback_lines bl    ON bl.id = dll.line_id
    WHERE br.dealer_entity_id = ${entityId}
    GROUP BY bd.request_id
  `);

  const settlementRows = await db.execute(sql`
    SELECT bd.request_id, st.leg, st.txn_ref
    FROM settlement_transactions st
    JOIN buyback_deals bd    ON bd.id = st.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    WHERE br.dealer_entity_id = ${entityId}
      AND st.leg = 'DEALER'
    ORDER BY st.created_at
  `);

  const byRequest = new Map<
    string,
    { locked_dealer_total: number; settlements: Array<{ leg: string; txn_ref: string | null }> }
  >();

  for (const r of lockRows as unknown as Array<Record<string, unknown>>) {
    byRequest.set(String(r.request_id), {
      locked_dealer_total: Number(r.locked_dealer_total),
      settlements: [],
    });
  }

  for (const s of settlementRows as unknown as Array<Record<string, unknown>>) {
    // A settlement presupposes locks, so the entry exists; if the data is ever
    // inconsistent, a settlement without locks stays invisible — the safe side.
    byRequest.get(String(s.request_id))?.settlements.push({
      leg: String(s.leg),
      txn_ref: (s.txn_ref as string) ?? null,
    });
  }

  return byRequest;
}
