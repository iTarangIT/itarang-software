/**
 * Rendering a lender's loan products for a customer, in chat.
 *
 * Pure and DB-free so the rules below can be unit tested — this repo's vitest
 * scope is no-I/O helpers, and every rule here is one that produced a visible
 * defect in a real conversation.
 *
 * WHY PRODUCTS ARE MASKED TOO.
 *
 * `schemeName()` (./scheme-name) exists so a forwardable chat message never
 * names the lender. That guarantee was being broken two lines later: the
 * product block printed `p.productName` — the lender's OWN product name —
 * verbatim. In the test data that renders "iTarang Finance Scheme 2"; for a real
 * lender it would read "Bajaj Finserv EV Loan", which names the lender exactly
 * as well as the lender's name would. So products get positional labels too, and
 * `productName` is never rendered in chat. (It is still what the dealer and the
 * NBFC see in the portal — only this surface masks it.)
 *
 * WHY THE NUMBER HELPERS EXIST.
 *
 * The BRE returns each band as a min and a max. When a product has one fixed
 * rate those are equal, and printing the range unconditionally produced
 * "ROI 20.00–20.00% · 12–12 months" — which reads like a bug to a customer and
 * buries the one number they care about. `range()` collapses an equal pair;
 * `num()` strips the trailing zeros a numeric(x,2) column always carries.
 *
 * `num()` strips zeros but does NOT round. A down payment of 11.11% is money the
 * customer will actually hand over, and rounding it to "11%" in the message they
 * were sold on is not a formatting improvement.
 */

/** Meta caps a list-row title at 24 characters and truncates silently. */
export const ROW_TITLE_MAX = 24;
/** …and a row description at 72. */
export const ROW_DESC_MAX = 72;

/**
 * Positional product label — `Option A`, `Option B`, … Beyond 26 products it
 * falls back to a number, which no real lender will reach but which is better
 * than emitting a character past 'Z'.
 */
export function optionLabel(index: number): string {
  if (index < 0) return "Option";
  if (index < 26) return `Option ${String.fromCharCode(65 + index)}`;
  return `Option ${index + 1}`;
}

/**
 * A decimal string as a customer should read it: trailing zeros gone, value
 * unchanged. `"20.00"` → `"20"`, `"11.10"` → `"11.1"`, `"11.11"` → `"11.11"`.
 * Non-numeric input is passed through rather than becoming "NaN" in a message.
 */
export function num(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  // toFixed(2) first so 20 and "20.00" render identically, then drop the zeros.
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * A band, collapsed when it is not really a band. `range(12, 12, "months")` →
 * `"12 months"`; `range(12, 24, "months")` → `"12–24 months"`.
 */
export function range(
  min: string | number | null | undefined,
  max: string | number | null | undefined,
  unit = "",
): string {
  const lo = num(min);
  const hi = num(max);
  const suffix = unit ? ` ${unit}` : "";
  if (lo === hi) return `${lo}${suffix}`;
  return `${lo}–${hi}${suffix}`;
}

/** A percentage band: `"14%"` or `"14–18%"`. */
export function pctRange(
  min: string | number | null | undefined,
  max: string | number | null | undefined,
): string {
  const lo = num(min);
  const hi = num(max);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/**
 * The down payment, said in words. Zero is worth calling out positively — it is
 * the single most persuasive term on the card, and "0% down payment" reads like
 * a missing value.
 */
export function downPaymentText(pct: string | number | null | undefined): string {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return "No down payment";
  return `${num(pct)}% down payment`;
}

/** Rupees, grouped Indian-style. */
export function inr(value: string | number | null | undefined): string {
  const n = Number(value);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : "—";
}

/** A loan-amount band: `"₹30,000–₹73,999"`, collapsed when equal. */
export function loanRange(
  min: string | number | null | undefined,
  max: string | number | null | undefined,
): string {
  const lo = inr(min);
  const hi = inr(max);
  return lo === hi ? lo : `${lo}–${hi}`;
}

/**
 * A picker row's title: `Scheme 1 · Option A`.
 *
 * NOT `schemeName()` on its own, which is what shipped — every product of one
 * lender then got an identical row title and the customer could not tell two
 * offers apart. Worst case here is `Scheme 10 · Option Z` at 20 characters,
 * inside Meta's cap.
 */
export function rowTitle(schemeIndex: number, optionIndex: number): string {
  return `Scheme ${schemeIndex + 1} · ${optionLabel(optionIndex)}`.slice(
    0,
    ROW_TITLE_MAX,
  );
}

/** The fields of a loan product this module renders. */
export interface FormattableProduct {
  loanAmountMin: number;
  loanAmountMax: number;
  tenureMonthsMin: number;
  tenureMonthsMax: number;
  minRoiPct: string;
  maxRoiPct: string;
  downPaymentPct: string;
}

/**
 * A picker row's description — the terms that actually differ between two
 * options, in the order a borrower weighs them.
 */
export function rowDescription(p: FormattableProduct): string {
  return `${pctRange(p.minRoiPct, p.maxRoiPct)} · ${range(
    p.tenureMonthsMin,
    p.tenureMonthsMax,
    "months",
  )} · ${downPaymentText(p.downPaymentPct).toLowerCase()}`.slice(0, ROW_DESC_MAX);
}

/**
 * One product, as three indented lines under its scheme.
 *
 * Indented with two spaces, not the four-plus that shipped: WhatsApp wraps a
 * long line at the viewport and the continuation returns to column zero, so deep
 * indentation produced the ragged block in the report ("11.11%" on one line,
 * "down" alone on the next).
 */
export function productLines(p: FormattableProduct, optionIndex: number): string {
  return (
    `  *${optionLabel(optionIndex)}* — ${pctRange(p.minRoiPct, p.maxRoiPct)} · ` +
    `${range(p.tenureMonthsMin, p.tenureMonthsMax, "months")}\n` +
    `  ${downPaymentText(p.downPaymentPct)}\n` +
    `  Loan ${loanRange(p.loanAmountMin, p.loanAmountMax)}`
  );
}
