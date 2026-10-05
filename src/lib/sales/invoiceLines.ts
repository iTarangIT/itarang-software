/**
<<<<<<< HEAD
 * Sales invoice line items — the pure rules (tracker ID 72, E-326).
 * CLIENT-SAFE: no db import. The SQL twins live in src/lib/dashboard/grossMargin.ts.
 */

export interface InvoiceLineCandidate {
  description: string | null;
  hsn_code: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}

export interface InvoiceLine {
  line_no: number;
  description: string;
  item_key: string;
  hsn_code: string | null;
  quantity: number;
  rate: number | null;
  amount: number;
}

/**
 * What a line is, for the "by business type" split. Classified by HSN, never
 * by the item name (spec ID 39): 8507 = batteries, 8504.40 = chargers,
 * 8548 / 8549 = battery scrap.
 */
export const LINE_TYPES = ["battery", "charger", "scrap", "other"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const LINE_TYPE_LABELS: Record<LineType, string> = {
  battery: "Batteries",
  charger: "Chargers",
  scrap: "Scrap",
  other: "Other",
};

export function lineTypeFromHsn(hsn: string | null | undefined): LineType | null {
  const h = (hsn ?? "").replace(/\D/g, "");
  if (!h) return null;
  if (h.startsWith("8507")) return "battery";
  if (h.startsWith("850440")) return "charger";
  if (h.startsWith("8548") || h.startsWith("8549")) return "scrap";
  return "other";
}

/** The mapping key for an item name: lower-case, punctuation and spacing folded. */
export function itemKey(description: string | null | undefined): string {
  return (description ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** "51.2V 105Ah Li-ion" → { voltage: 51, capacity: 105 }; null when either is absent. */
export function parseVoltAh(description: string | null | undefined): { voltage: number; capacity: number } | null {
  const s = description ?? "";
  const v = s.match(/(\d{2,3}(?:\.\d+)?)\s*v(?:olt)?s?\b/i);
  const a = s.match(/(\d{2,4}(?:\.\d+)?)\s*ah\b/i);
  if (!v || !a) return null;
  return { voltage: Math.floor(Number(v[1])), capacity: Math.round(Number(a[1])) };
}

/**
 * Keep the lines that can be costed: a description, a positive quantity and a
 * positive amount. A missing amount is rebuilt from quantity × rate.
 */
export function cleanInvoiceLines(candidates: InvoiceLineCandidate[]): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  for (const c of candidates) {
    const description = (c.description ?? "").trim();
    const quantity = c.quantity ?? 0;
    const amount = c.amount ?? (c.rate != null && quantity > 0 ? c.rate * quantity : null);
    if (!description || !(quantity > 0) || amount == null || !(amount > 0)) continue;
    lines.push({
      line_no: lines.length + 1,
      description,
      item_key: itemKey(description),
      hsn_code: (c.hsn_code ?? "").replace(/\D/g, "").slice(0, 16) || null,
      quantity,
      rate: c.rate,
      amount: Math.round(amount * 100) / 100,
    });
  }
  return lines;
}

/** Lines are trusted only when they add up to the invoice's taxable value. */
export const LINES_TOLERANCE_PCT = 0.5;
export const LINES_TOLERANCE_MIN = 2;

export function linesAddUp(lines: Pick<InvoiceLine, "amount">[], subTotal: number | null | undefined): boolean {
  if (subTotal == null || !(subTotal > 0) || lines.length === 0) return false;
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  return Math.abs(sum - subTotal) <= Math.max(LINES_TOLERANCE_MIN, (subTotal * LINES_TOLERANCE_PCT) / 100);
=======
 * Invoice line items (E-322, tracker IDs 39, 70) — the shared rules for every
 * source that can supply lines: the one-time Zoho backfill and the weekly
 * Vyapar sales-register import.
 *
 * Batteries sold are counted from invoice lines only (Kartik, 26 Sep): stock
 * allocation is not used. A line is classified by its HSN code:
 *   8507…   → battery  (electric accumulators)
 *   850440… → charger  (static converters)
 *   other   → other
 */

export const PRODUCT_CLASSES = ["battery", "charger", "other"] as const;
export type ProductClass = (typeof PRODUCT_CLASSES)[number];

/** Digits only, e.g. "8507.60.00" → "85076000". */
export function normalizeHsn(raw: unknown): string | null {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(0, 12) : null;
}

export function classifyHsn(raw: unknown): ProductClass {
    const hsn = normalizeHsn(raw);
    if (!hsn) return "other";
    if (hsn.startsWith("8507")) return "battery";
    if (hsn.startsWith("850440")) return "charger";
    return "other";
}

/** The key a Vyapar item name is mapped by: lower-case, single spaces. */
export function itemKey(name: unknown): string {
    return String(name ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/** Parse an Indian-formatted number cell ("1,23,456.50", "₹ 500", "(250)"). */
export function parseAmount(raw: unknown): number | null {
    if (raw == null || raw === "") return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    let s = String(raw).trim();
    const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
    s = s.replace(/[^\d.]/g, "");
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
}
