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

/**
 * The same fact as a VALUE, for a line that already carries the label.
 *
 * `downPaymentText` is a whole sentence ("11.11% down payment"), so putting it
 * after a "Down payment:" label produced "Down payment: 11.11% down payment".
 * The two forms exist because the picker row has no room for a label and the
 * detail block has one.
 */
export function downPaymentValue(pct: string | number | null | undefined): string {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return "None";
  return `${num(pct)}%`;
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

  // Optional so a caller holding only the headline bands still type-checks —
  // every one of these is `null` on a legacy loan-product row, and a card that
  // refused to render without them would show nothing at all.
  processingFeeRupees?: number | null;
  healthLifeInsuranceRupees?: number | null;
  disbursementTatHours?: number | null;
  fileChargeFixed?: string | null;
  fileChargePct?: string | null;
  subventionAvailable?: boolean | null;
  cibilRequired?: boolean | null;
  minCreditScore?: number | null;
  maxCreditScore?: number | null;
}

/** A rupee amount that is only worth a line when it is actually charged. */
function positiveRupees(value: number | string | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The file charge, which the schema models two mutually-exclusive ways —
 * `file_charge_fixed` (rupees) or `file_charge_pct` (% of the loan). A product
 * setting both is a data error rather than a real double charge, so the fixed
 * amount wins: it is the one a customer can be quoted without knowing their
 * final loan amount.
 */
export function fileChargeText(p: FormattableProduct): string | null {
  const fixed = positiveRupees(p.fileChargeFixed);
  if (fixed !== null) return inr(fixed);
  const pct = positiveRupees(p.fileChargePct);
  return pct !== null ? `${num(p.fileChargePct)}% of loan` : null;
}

/**
 * Turnaround, in the unit a person actually uses.
 *
 * Days ONLY for a whole number of them — 48h is "2 days", but 44h is "44h",
 * not "1.83 days". Dividing unconditionally produced exactly that, and a
 * fractional day is both harder to read than the hours it came from and
 * falsely precise about when the money lands.
 */
export function tatText(hours: number | null | undefined): string | null {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n % 24 !== 0) return `${num(n)}h`;
  const days = n / 24;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The credit-score requirement, said only when it is a real gate.
 *
 * `cibilRequired === false` means the bureau check is waived, which is GOOD
 * news and worth stating. `null` is a legacy row where nobody recorded the
 * answer — silence is correct there, because inventing "no credit check" would
 * be a promise the lender never made.
 */
export function creditScoreText(p: FormattableProduct): string | null {
  if (p.cibilRequired === false) return "No credit-score check";
  if (p.cibilRequired !== true) return null;
  const lo = p.minCreditScore;
  const hi = p.maxCreditScore;
  if (lo == null && hi == null) return "Credit-score check applies";
  if (lo != null && hi != null && hi > lo) return `Credit score ${lo}–${hi}`;
  return `Credit score ${lo ?? hi}+`;
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
 * One product, as a labelled block under its scheme.
 *
 * Indented with two spaces, not the four-plus that shipped: WhatsApp wraps a
 * long line at the viewport and the continuation returns to column zero, so deep
 * indentation produced the ragged block in the report ("11.11%" on one line,
 * "down" alone on the next).
 *
 * LABELS, NOT BARE NUMBERS. The first version ran the terms together as
 * `20% · 12 months` on one line and `11.11% down payment` on the next, which
 * asks the reader to infer that the first number is interest. Each line now
 * names what it is, because this message is the basis of a borrowing decision
 * and it gets forwarded to people who did not see the conversation.
 *
 * EVERY OPTIONAL LINE IS OMITTED WHEN ABSENT, never rendered as "—". A dash
 * against "Processing fee" reads as a charge nobody could name; no line at all
 * correctly says the scheme does not carry one. `positiveRupees` also treats 0
 * as absent for the same reason.
 */
export function productLines(p: FormattableProduct, optionIndex: number): string {
  const lines = [
    `  *${optionLabel(optionIndex)}*`,
    `  • Interest: ${pctRange(p.minRoiPct, p.maxRoiPct)} p.a.`,
    `  • Tenure: ${range(p.tenureMonthsMin, p.tenureMonthsMax, "months")}`,
    `  • Down payment: ${downPaymentValue(p.downPaymentPct)}`,
    `  • Loan amount: ${loanRange(p.loanAmountMin, p.loanAmountMax)}`,
  ];

  const processing = positiveRupees(p.processingFeeRupees);
  if (processing !== null) lines.push(`  • Processing fee: ${inr(processing)}`);

  const fileCharge = fileChargeText(p);
  if (fileCharge) lines.push(`  • File charge: ${fileCharge}`);

  const insurance = positiveRupees(p.healthLifeInsuranceRupees);
  if (insurance !== null) lines.push(`  • Health & life cover: ${inr(insurance)}`);

  const tat = tatText(p.disbursementTatHours);
  if (tat) lines.push(`  • Disbursal in: ${tat}`);

  const credit = creditScoreText(p);
  if (credit) lines.push(`  • ${credit}`);

  if (p.subventionAvailable) lines.push(`  • Subvention available`);

  return lines.join("\n");
}
