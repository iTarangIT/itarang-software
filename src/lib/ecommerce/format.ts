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

/**
 * Rupees (what the operator types) to minor units (what the API stores).
 *
 * This conversion is the single most dangerous line in the write path: getting
 * it wrong by a factor of 100 prices a product at ₹12.34 instead of ₹1,234.
 * Callers must show the returned integer to the operator before submitting, and
 * the server re-validates it independently rather than trusting the client.
 *
 * Returns null for anything that is not a positive amount with at most `digits`
 * decimal places, so a bad input fails loudly instead of rounding silently.
 */
export function rupeesToMinor(input: string, currencyCode = "inr"): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const digits = minorUnitDigits(currencyCode);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > digits) return null;

  const padded = frac.padEnd(digits, "0");
  // String concatenation rather than `value * 100`, which loses pennies to
  // floating point (1234.56 * 100 === 123455.99999999999).
  const minor = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(minor) || minor < 1) return null;
  return minor;
}

/** Minor units back to a plain editable string (no symbol, no grouping). */
export function minorToRupees(amountMinor: number, currencyCode = "inr"): string {
  const digits = minorUnitDigits(currencyCode);
  return (amountMinor / 10 ** digits).toFixed(digits);
}
