/**
 * The GST arithmetic behind a quotation, and the IGST-vs-CGST+SGST decision.
 *
 * Pure — no DB, no config, no rendering. Everything the totals block prints is
 * computed here so it can be asserted against docs/ITPI-35 (1).pdf without a
 * browser: that document's four lines must produce sub-total 8,41,500,
 * IGST18 1,33,920, IGST5 4,875 and total 9,80,295.
 *
 * ## Why the place of supply decides the split
 *
 * GST is destination-based. Where the supply crosses a state border it is
 * INTEGRATED (IGST, one row at the full rate); where it stays inside one state
 * it is split into CENTRAL and STATE halves (CGST+SGST, two rows at half the
 * rate each). The two cases total identically — the difference is which
 * governments get the money, and therefore which registers the document must
 * name. Getting it wrong does not change what the dealer pays but does make the
 * document wrong as a tax document.
 *
 * ## Why an unset rate is not a zero rate
 *
 * E-242 adds `gst_rate_pct` to the product masters nullable and does not
 * backfill it. NULL means "the catalogue has not been told", which is a
 * different statement from "this line is zero-rated" — the second is a claim
 * about tax law that nobody at iTarang has made. So a NULL rate contributes
 * nothing to any tax row, is reported through `hasUnsetTax`, and the template
 * marks the line rather than quietly printing 0.00.
 *
 * Since E-256 the business HAS made a claim for the three known asset types
 * (battery 18, charger 5, paraphernalia 18): the masters are backfilled and
 * view.ts falls back to DEFAULT_TAX_BY_ASSET_TYPE, so a rate only reaches here
 * as NULL for an asset type the policy doesn't name. The NULL handling stays
 * for exactly that case.
 */
import type { GstRate, QuotationLineView, TaxRow } from "./types";

/** Round to paise. Money is compared for equality all over this file. */
export function toPaise(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A rate is usable when it is a finite, non-negative number. */
export function hasRate(rate: GstRate): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
}

/**
 * Tax on one line. Returns null exactly when the rate is unset, so callers
 * cannot accidentally treat "unknown" and "zero" as the same value.
 */
export function lineGstAmount(amount: number, rate: GstRate): number | null {
  if (!hasRate(rate)) return null;
  return toPaise((amount * rate) / 100);
}

/**
 * How a rate is named in the totals block.
 *
 * ITPI-35 writes `IGST18 (18%)` — the register name with the rate appended to
 * it, then the rate again in brackets. The shape is kept and the integrated
 * register is printed as `GST18 (18%)` — see computeTotals. A whole-number rate prints without a
 * decimal (18, not 18.00); a fractional one keeps what it needs.
 */
export function rateSuffix(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : String(rate).replace(/\.?0+$/, "");
}

function taxLabel(register: string, rate: number): string {
  return `${register}${rateSuffix(rate)} (${rateSuffix(rate)}%)`;
}

export interface TaxComputation {
  subTotal: number;
  taxRows: TaxRow[];
  taxTotal: number;
  total: number;
  hasUnsetTax: boolean;
  isIntraState: boolean;
}

export interface ComputeTotalsInput {
  lines: Pick<QuotationLineView, "amount" | "gstRatePct">[];
  /** State the goods ship FROM (ours). */
  sellerStateCode: string;
  /** State the goods ship TO. NULL when the lead has no resolvable state. */
  placeOfSupplyStateCode: string | null;
}

/**
 * Sub-total, one tax row per distinct rate, and the grand total.
 *
 * ONE ROW PER DISTINCT RATE, not per line: ITPI-35 carries three 18% lines and
 * one 5% line and prints exactly two tax rows. Rows are ordered by rate
 * descending, which is the order that document uses (GST18 above GST5).
 *
 * When the place of supply is unknown the supply is treated as INTER-state.
 * That is the conservative reading — an unknown destination is more likely to
 * be outside Haryana than inside it, and IGST is the single-row form, so an
 * unknown place of supply cannot silently split a rate into two registers that
 * name the wrong state.
 */
export function computeTotals(input: ComputeTotalsInput): TaxComputation {
  const { lines, sellerStateCode, placeOfSupplyStateCode } = input;

  const isIntraState =
    placeOfSupplyStateCode != null &&
    placeOfSupplyStateCode.trim() !== "" &&
    placeOfSupplyStateCode.trim() === sellerStateCode.trim();

  const subTotal = toPaise(
    lines.reduce((sum, l) => sum + (Number.isFinite(l.amount) ? l.amount : 0), 0),
  );

  // Bucket by rate. A Map keyed on the numeric rate keeps 18 and 18.00 together
  // — they are the same rate and must not produce two rows.
  const byRate = new Map<number, number>();
  let hasUnsetTax = false;

  for (const line of lines) {
    const rate = line.gstRatePct;
    if (!hasRate(rate)) {
      hasUnsetTax = true;
      continue;
    }
    const amount = lineGstAmount(line.amount, rate) ?? 0;
    byRate.set(rate, toPaise((byRate.get(rate) ?? 0) + amount));
  }

  const rates = [...byRate.keys()].sort((a, b) => b - a);
  const taxRows: TaxRow[] = [];

  for (const rate of rates) {
    const amount = byRate.get(rate) ?? 0;
    // A rate that produces no tax at all (a zero rate, or zero-value lines)
    // still earns its row: the document should say the rate was applied.
    if (isIntraState) {
      // Split at the HALF RATE, and halve the AMOUNT rather than recomputing at
      // half the rate — recomputing twice can round each half up and total a
      // paisa more than the IGST form of the same supply.
      //
      // CGST takes the FLOOR and SGST the remainder, so the two halves sum to
      // exactly `amount` no matter how the paise fall. Rounding both halves
      // independently is the bug this avoids: 0.15 would become 0.08 + 0.08.
      const cgst = Math.floor(toPaise(amount) * 100 / 2) / 100;
      const sgst = toPaise(amount - cgst);
      taxRows.push({ label: taxLabel("CGST", rate / 2), amount: cgst });
      taxRows.push({ label: taxLabel("SGST", rate / 2), amount: sgst });
    } else {
      // Named "GST", not "IGST" — a business decision (2026-08-20). The supply
      // IS integrated and the arithmetic is unchanged; the dealers reading these
      // quotations asked what "IGST" meant often enough that the register name
      // was costing more than it explained. The intra-state branch above keeps
      // CGST/SGST because those two rows only make sense named.
      taxRows.push({ label: taxLabel("GST", rate), amount });
    }
  }

  const taxTotal = toPaise(taxRows.reduce((sum, r) => sum + r.amount, 0));
  const total = toPaise(subTotal + taxTotal);

  return { subTotal, taxRows, taxTotal, total, hasUnsetTax, isIntraState };
}
