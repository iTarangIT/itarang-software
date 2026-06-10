/**
 * Out-of-band financing-offer deviation detection — BRD Addendum V0.3.1 §13.3.3.
 *
 * A firm financing offer (`nbfc_financing_offers`) is "out of band" when one or
 * more of its terms fall outside the matched loan product's configured ranges
 * (`nbfc_loan_products`). An out-of-band offer must be approved by the iTarang
 * CEO (§13.3.4) before it is released to the dealer's compare-and-pick screen.
 *
 * This module is a PURE function (no DB, no I/O) so it is trivially testable and
 * can be reused by the offer route and any future band-guidance UI. The offer
 * route owns fetching the offer values and the product bands and persisting the
 * result.
 *
 * Down-payment is intentionally NOT band-checked here: the product stores a
 * single down_payment_pct (a percentage of asset price) while the offer stores an
 * absolute rupee amount with no asset price on the offer — comparing them is
 * ambiguous, so a v1 deviation on down-payment would be unreliable. ROI, tenure
 * and loan amount are unambiguous min/max bands and are the BRD's primary levers.
 */

export interface OfferTerms {
  roi_pct: number | null;
  tenure_months: number | null;
  loan_amount: number | null;
}

export interface ProductBands {
  min_roi_pct: number | null;
  max_roi_pct: number | null;
  tenure_months_min: number | null;
  tenure_months_max: number | null;
  loan_amount_min: number | null;
  loan_amount_max: number | null;
}

export interface DeviationField {
  field: "roi_pct" | "tenure_months" | "loan_amount";
  label: string;
  value: number;
  min: number;
  max: number;
}

export interface DeviationResult {
  detected: boolean;
  fields: DeviationField[];
  /** Human-readable one-liner, e.g. "ROI 22% outside band 14–20%; Tenure 48mo outside 12–36mo". */
  reason: string | null;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Compares an offer's terms against the product bands. A field deviates only when
 * BOTH the offer value AND both band edges are present (a missing band can't be
 * violated). Returns detected=false (in-band, no gate) when nothing is outside.
 */
export function computeOfferDeviation(offer: OfferTerms, bands: ProductBands): DeviationResult {
  const checks: { field: DeviationField["field"]; label: string; suffix: string; value: number | null; min: number | null; max: number | null }[] = [
    { field: "roi_pct", label: "ROI", suffix: "%", value: num(offer.roi_pct), min: num(bands.min_roi_pct), max: num(bands.max_roi_pct) },
    { field: "tenure_months", label: "Tenure", suffix: "mo", value: num(offer.tenure_months), min: num(bands.tenure_months_min), max: num(bands.tenure_months_max) },
    { field: "loan_amount", label: "Loan amount", suffix: "", value: num(offer.loan_amount), min: num(bands.loan_amount_min), max: num(bands.loan_amount_max) },
  ];

  const fields: DeviationField[] = [];
  const parts: string[] = [];
  for (const c of checks) {
    if (c.value == null || c.min == null || c.max == null) continue;
    if (c.value < c.min || c.value > c.max) {
      fields.push({ field: c.field, label: c.label, value: c.value, min: c.min, max: c.max });
      parts.push(`${c.label} ${c.value}${c.suffix} outside band ${c.min}–${c.max}${c.suffix}`);
    }
  }

  return {
    detected: fields.length > 0,
    fields,
    reason: parts.length ? parts.join("; ") : null,
  };
}
