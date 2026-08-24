/**
 * Turning a dealer's stock into WhatsApp list rows.
 *
 * Pure and DB-free on purpose: the rules it encodes are Meta's hard limits, and
 * breaking one of them fails at SEND time — the customer sees nothing at all,
 * from a code path that looked fine in review. So they are unit tested, which
 * means this cannot import `db` (this repo's vitest scope is no-I/O helpers).
 *
 * The limits, and what each one costs if it is wrong:
 *   - ≤10 rows per list. An 11th row means Meta rejects the whole message.
 *   - Row title ≤24 chars, description ≤72. The adapter truncates, so an
 *     over-long title silently loses the end — which is where a serial number
 *     would be if the layout were the other way round.
 *
 * Hence the layout: the MODEL goes in the title (short, and what the customer
 * recognises) and the price + serial go in the description (longer budget, and
 * the serial is the thing that must survive intact).
 */

import type { ListRow } from "./types";

/** Meta's hard cap on interactive list rows. */
export const MAX_ROWS = 10;
/** One row is reserved for "show more", so a page holds nine. */
export const PAGE_SIZE = MAX_ROWS - 1;

/** The fields of a stock row this module needs. */
export interface StockRowItem {
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  price: string | null;
  net_amount: string | null;
  recommended: boolean;
}

export const inr = (v: string | number | null | undefined): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `₹${n.toLocaleString("en-IN")}` : "—";
};

/**
 * What the customer pays for one line.
 *
 * `net_amount` is the GST-inclusive figure captured on the inventory row at OEM
 * upload — the real number. `price` is the product's list price and only stands
 * in when the snapshot is missing, so a lead is never shown a blank price.
 */
export function lineTotal(item: Pick<StockRowItem, "net_amount" | "price">): number {
  const net = Number(item.net_amount);
  if (Number.isFinite(net) && net > 0) return net;
  const price = Number(item.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

/**
 * One page of stock as list rows, plus a "show more" row when there is another
 * page. Row ids are `<prefix>:<serial>` — deliberately NOT a `LEAD_ACTIONS`
 * prefix, so `parseLeadAction` ignores them and they reach the phase's state
 * handler as ordinary text (the same convention `step4-flow` uses for `s4p:`).
 */
export function stockRows(
  items: StockRowItem[],
  prefix: "dpb" | "dpc",
  page: number,
): ListRow[] {
  const start = page * PAGE_SIZE;
  const rows: ListRow[] = items.slice(start, start + PAGE_SIZE).map((it) => ({
    id: `${prefix}:${it.serial_number}`,
    title: `${it.recommended ? "⭐ " : ""}${it.model_name ?? it.model_type ?? "Battery"}`.slice(0, 24),
    description: `${inr(lineTotal(it))} · SN ${it.serial_number}`.slice(0, 72),
  }));
  const remaining = items.length - (start + PAGE_SIZE);
  if (remaining > 0) {
    rows.push({
      id: `${prefix}_more`,
      title: "▸ Show more",
      description: `${remaining} more in stock`.slice(0, 72),
    });
  }
  return rows;
}
