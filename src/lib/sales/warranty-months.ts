/**
 * Warranty duration resolution — PURE and DB-free so it can be unit tested.
 * The business reason is in the doc comment below; `finalizeSale` and the
 * repair script both call this so they can never disagree.
 */

/** Applied when no source carries a positive warranty duration. */
export const DEFAULT_WARRANTY_MONTHS = 24;

/**
 * Pick the warranty duration for a battery.
 *
 * Positive-first, in this order: the inventory row's own `warranty_months`
 * (what the dealer/admin entered or the seed wrote for THIS unit), then the
 * product master, then the OEM figure, then the 24-month default.
 *
 * Every one of those columns is `integer NOT NULL DEFAULT 0` or nullable, and
 * the Step-4 product route stubs `products` rows with `warranty_months: 0` for
 * any model it cannot match — so a bare `?? 24` on the product column produced
 * warranties that expired on the day of dispatch. Zero is "unknown" here, never
 * "no warranty".
 */
export function resolveWarrantyMonths(src: {
  inventory_warranty_months?: number | null;
  product_warranty_months?: number | null;
  oem_warranty_months?: number | null;
}): number {
  for (const v of [
    src.inventory_warranty_months,
    src.product_warranty_months,
    src.oem_warranty_months,
  ]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return DEFAULT_WARRANTY_MONTHS;
}
