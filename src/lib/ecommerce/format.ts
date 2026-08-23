/** Presentation helpers for the Hostinger Ecommerce views. */

import type { EcommercePrice, EcommercePriceRange } from "./types";

/**
 * How many minor units make one major unit for a currency.
 *
 * The documented API returns only an ISO currency code — unlike the old
 * undocumented surface it carries no `decimal_digits`, so the exponent is derived
 * from Intl rather than read off the payload. Falls back to 2, which is right for
 * INR and every other currency this store is likely to use; guessing 0 would
 * render paise as rupees and overstate every price by 100x.
 */
function minorUnitDigits(currencyCode: string): number {
  try {
    const fmt = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currencyCode.toUpperCase(),
    });
    return fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function formatMinor(amountMinor: number, currencyCode: string): string {
  const digits = minorUnitDigits(currencyCode);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currencyCode.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${currencyCode.toUpperCase()} ${major.toFixed(digits)}`;
  }
}

export function formatPrice(price: EcommercePrice | null): string {
  if (!price || price.amountMinor === null) return "—";
  return formatMinor(price.amountMinor, price.currencyCode);
}

/**
 * Renders a span. Single-variant products report min === max, so those collapse
 * to one figure rather than showing a pointless "X – X".
 */
export function formatPriceRange(range: EcommercePriceRange | null): string {
  if (!range || range.minMinor === null) return "—";
  const min = formatMinor(range.minMinor, range.currencyCode);
  if (range.maxMinor === null || range.maxMinor === range.minMinor) return min;
  return `${min} – ${formatMinor(range.maxMinor, range.currencyCode)}`;
}
