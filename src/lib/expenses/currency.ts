/**
 * E-217 — pure currency helpers.
 *
 * Deliberately separate from `fx.ts`, which imports the DB client and so
 * cannot be loaded by the vitest suite (scoped to pure, no-I/O units — see
 * vitest.config.ts). The rules that decide *whether* money needs converting
 * are exactly the part worth pinning down in tests, so they live here.
 */

export const BASE_CURRENCY = "INR";

/**
 * Does this amount already count as rupees?
 *
 * An ABSENT currency counts as INR. The extractor returns null when the
 * document does not print a code, which on an Indian company's books means a
 * rupee bill — treating it as unknown would flag most of the folder for no
 * reason. A currency that is present and different is what must be converted:
 * `expense_submissions.amount` is one numeric column that every dashboard
 * SUMs, so anything mis-classified here is silently added to the total at face
 * value. That is how $1,123 of SaaS invoices came to be booked as ₹1,123.
 */
export function isBaseCurrency(currency: string | null | undefined): boolean {
  if (!currency) return true;
  return currency.trim().toUpperCase() === BASE_CURRENCY;
}

/** Normalise an extracted currency code, or null if there isn't one. */
export function normaliseCurrency(currency: string | null | undefined): string | null {
  if (!currency) return null;
  const c = currency.trim().toUpperCase();
  return c || null;
}

/** Round to the 2dp that `numeric(14,2)` will store anyway. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Last-resort rates, used only when the live lookup fails AND no rate is
 * configured in `app_settings.fx_rates_fallback`.
 *
 * Snapshot of the ECB reference rates on 2026-07-24. They go stale, which is
 * exactly why any row converted this way is flagged `needs_attention` rather
 * than silently trusted — and why an admin should set the app_settings
 * override instead of relying on these.
 *
 * JPY is quoted per 1 yen, so the small number is correct. AED and other
 * pegged currencies are absent from the ECB set entirely and fall through to
 * the unknown-currency path in fx.ts.
 */
export const EMERGENCY_FALLBACK_RATES: Record<string, number> = {
  USD: 96.56,
  EUR: 109.87,
  GBP: 128.66,
  AUD: 67.48,
  SGD: 74.8,
  CAD: 68.55,
  CHF: 118.1,
  JPY: 0.589,
};
