/**
 * Rendering for the "Active batteries" console screen — PURE and DB-free, the
 * same split `stock-rows.ts` makes and for the same reason: what this gets
 * wrong is what a dealer reads out to a customer about their warranty, so it is
 * unit tested, which means no `db` import here. The queries live in
 * ./active-batteries.
 */

import { MAX_ROWS, PAGE_SIZE } from "./stock-rows";
import type { ListRow } from "./types";

const ROW_PREFIX = "ab";

export interface ActiveBattery {
  warrantyId: string;
  serial: string;
  model: string | null;
  category: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deployedAt: Date;
  warrantyStart: Date | null;
  warrantyEnd: Date | null;
  /** E-268 column; NULL on rows written before it. See `warrantyMonthsOf`. */
  warrantyMonths: number | null;
  paymentType: string | null;
  paymentStatus: string | null;
  leadId: string | null;
}


/**
 * Months of cover. The persisted figure when present; otherwise the whole
 * months between the two dates, for rows written before E-268.
 */
export function warrantyMonthsOf(b: {
  warrantyMonths: number | null;
  warrantyStart: Date | null;
  warrantyEnd: Date | null;
}): number | null {
  if (typeof b.warrantyMonths === "number" && b.warrantyMonths > 0) return b.warrantyMonths;
  if (!b.warrantyStart || !b.warrantyEnd) return null;
  const s = b.warrantyStart;
  const e = b.warrantyEnd;
  const months =
    (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  return months > 0 ? months : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const dmy = (d: Date | null): string => (d ? d.toLocaleDateString("en-IN") : "—");

/** One page of list rows: `ab:<serial>` per battery, `ab_more` when more remain. */
export function activeBatteryRows(items: ActiveBattery[], page: number): ListRow[] {
  const start = Math.max(0, page) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const rows: ListRow[] = slice.map((b) => ({
    id: `${ROW_PREFIX}:${b.serial}`,
    title: clip(b.model ?? b.serial, 24),
    description: clip(
      [b.customerName ?? "—", `SN ${b.serial}`, `till ${dmy(b.warrantyEnd)}`].join(" · "),
      72,
    ),
  }));
  if (items.length > start + slice.length) {
    rows.push({
      id: `${ROW_PREFIX}_more`,
      title: "▸ Show more",
      description: clip(`${items.length - start - slice.length} more`, 72),
    });
  }
  return rows.slice(0, MAX_ROWS);
}

/** The detail card for one battery. Dealer-facing. */
export function activeBatteryCard(b: ActiveBattery): string {
  const months = warrantyMonthsOf(b);
  const expired = b.warrantyEnd ? b.warrantyEnd.getTime() < Date.now() : false;
  return [
    `🔋 *${b.model ?? b.serial}*`,
    `Serial *${b.serial}*`,
    "",
    `👤 ${b.customerName ?? "—"}`,
    `📞 ${b.customerPhone ?? "—"}`,
    "",
    `📦 Dispatched ${dmy(b.deployedAt)}`,
    `🛡 Warranty ${months ? `*${months} months*` : "—"} · ` +
      (b.warrantyEnd
        ? expired
          ? `expired ${dmy(b.warrantyEnd)}`
          : `valid until *${dmy(b.warrantyEnd)}*`
        : "no end date"),
    `💳 ${b.paymentType === "upfront" ? "Cash" : "Finance"}` +
      (b.paymentStatus ? ` · ${b.paymentStatus}` : ""),
    `🧾 Warranty id ${b.warrantyId}` + (b.leadId ? `\n🔗 Lead ${b.leadId}` : ""),
  ].join("\n");
}

