/**
 * What one commercials version changed about the one before it.
 *
 * ## Why this is a diff and not a "changed fields" flag on the row
 *
 * Nothing records what a revision changed, and nothing needs to: every version
 * is stored whole and immutable, so the answer is derivable and can never drift
 * from the data. Storing it would mean a column that is written once, trusted
 * forever, and wrong the first time a backfill touches a row.
 *
 * ## Why against the PREVIOUS version, not the current one
 *
 * The question a reader has in front of a version history is "what did THIS
 * revision change" — the step, not the distance from today. Diffing everything
 * against the current version makes every old row restate the same delta and
 * says nothing about the sequence.
 *
 * PURE, and formatting-inclusive: it returns display strings. The alternative —
 * returning raw values and formatting in the component — puts "₹40,000" in a
 * place no test can see it.
 */
import type { CommercialsProductLine, LeadDetailCommercials } from "./types";

export interface CommercialsChange {
  /** Already human-readable: "Final price", "Warranty", or a product name. */
  label: string;
  /** NULL means "was not set", which is different from a value of "0". */
  from: string | null;
  /** NULL means cleared or removed. */
  to: string | null;
}

/** A version, reduced to just the fields a diff looks at. */
type Diffable = Pick<
  LeadDetailCommercials,
  | "price_quoted"
  | "final_price"
  | "payment_method"
  | "credit_terms"
  | "delivery_terms"
  | "warranty_terms"
  | "deal_notes"
  | "product_lines"
>;

const money = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : String(v);
};

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

/** Same key oemPricing and the quotation view use, so the three agree. */
const lineKey = (l: CommercialsProductLine): string =>
  `${l.asset_type}:${l.product_id}`;

const lines = (c: Diffable): CommercialsProductLine[] =>
  Array.isArray(c.product_lines) ? c.product_lines : [];

/**
 * Scalar fields first, then product lines.
 *
 * Order is the order they are shown, and it is the order they matter in: price
 * before terms, terms before line detail.
 */
export function diffCommercials(
  prev: Diffable | null | undefined,
  next: Diffable,
): CommercialsChange[] {
  const out: CommercialsChange[] = [];

  // A first version changes nothing — it IS the baseline. Returning its whole
  // contents as "changes" would read as a revision that rewrote everything.
  if (!prev) return out;

  const scalars: [string, string | null, string | null][] = [
    ["Price quoted", money(prev.price_quoted), money(next.price_quoted)],
    ["Final price", money(prev.final_price), money(next.final_price)],
    ["Payment", text(prev.payment_method), text(next.payment_method)],
    ["Credit terms", text(prev.credit_terms), text(next.credit_terms)],
    ["Delivery", text(prev.delivery_terms), text(next.delivery_terms)],
    ["Warranty", text(prev.warranty_terms), text(next.warranty_terms)],
    ["Deal notes", text(prev.deal_notes), text(next.deal_notes)],
  ];

  for (const [label, from, to] of scalars) {
    if (from !== to) out.push({ label, from, to });
  }

  const before = new Map(lines(prev).map((l) => [lineKey(l), l]));
  const after = new Map(lines(next).map((l) => [lineKey(l), l]));

  for (const [key, l] of after) {
    const was = before.get(key);
    const name = l.product_name ?? l.model_id ?? key;

    if (!was) {
      out.push({ label: name, from: null, to: describeLine(l) });
      continue;
    }
    // Quantity and price are the two things a revision actually moves. A
    // renamed product is the catalogue changing under us, not this quote
    // changing, so it is deliberately not reported.
    if (was.quantity !== l.quantity || was.unit_price !== l.unit_price) {
      out.push({ label: name, from: describeLine(was), to: describeLine(l) });
    }
  }

  for (const [key, l] of before) {
    if (!after.has(key)) {
      out.push({
        label: l.product_name ?? l.model_id ?? key,
        from: describeLine(l),
        to: null,
      });
    }
  }

  return out;
}

/** "× 2 @ ₹51,000" — quantity always, price only when the rep set one. */
function describeLine(l: CommercialsProductLine): string {
  const price = l.unit_price == null ? null : money(l.unit_price);
  return price ? `× ${l.quantity} @ ${price}` : `× ${l.quantity}`;
}

/**
 * The one-line summary a history row shows: "Final price ₹40,000 → ₹51,000 ·
 * Warranty 12 → 24". Capped, because a row that wraps to four lines stops being
 * a summary; the full detail is one expand away.
 */
export function summariseChanges(changes: CommercialsChange[], max = 3): string {
  if (changes.length === 0) return "";
  const shown = changes
    .slice(0, max)
    .map((c) => `${c.label} ${c.from ?? "—"} → ${c.to ?? "—"}`)
    .join(" · ");
  const rest = changes.length - max;
  return rest > 0 ? `${shown} · +${rest} more` : shown;
}
