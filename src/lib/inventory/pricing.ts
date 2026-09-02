/**
 * Inventory pricing helpers — the ONE place that turns an OEM base value into
 * the GST-inclusive price the dealer sells at.
 *
 *   gstAmount          = base × gstPct / 100
 *   priceInclusiveGst  = base + gstAmount   (= base × (1 + gstPct / 100))
 *
 * Both are rounded to paise (2 dp) so the stored numeric(12,2) columns
 * (`inventory.gst_amount`, `inventory.final_amount`,
 * `inventory.price_inclusive_gst`) reconcile exactly.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** GST on a pre-tax base value, in rupees (2 dp). 0 when either input is unset. */
export function gstAmount(base: unknown, gstPct: unknown): number {
  const b = num(base);
  const p = num(gstPct);
  if (b <= 0 || p <= 0) return 0;
  return round2((b * p) / 100);
}

/** Base value + GST — the "Price Inclusive GST" column. */
export function priceInclusiveGst(base: unknown, gstPct: unknown): number {
  const b = num(base);
  if (b <= 0) return 0;
  return round2(b + gstAmount(b, gstPct));
}

/** Convenience for the write routes: every stored money field in one go. */
export function inventoryPriceFields(base: unknown, gstPct: unknown): {
  gstPercent: number;
  gstAmount: number;
  priceInclusiveGst: number;
} {
  const gstPercent = num(gstPct);
  return {
    gstPercent,
    gstAmount: gstAmount(base, gstPercent),
    priceInclusiveGst: priceInclusiveGst(base, gstPercent),
  };
}
