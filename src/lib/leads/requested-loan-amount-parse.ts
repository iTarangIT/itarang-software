/**
 * E-275 — pure parsing/formatting for the requested loan amount. No I/O, so
 * it is unit-testable and importable from client components.
 */

export const MIN_REQUESTED_LOAN = 1;
export const MAX_REQUESTED_LOAN = 10_000_000;

/**
 * Parse a rupee amount typed by a human. Accepts plain digits, Indian
 * grouping, ₹/Rs prefixes, and k / lakh / lac / L suffixes. Returns null when
 * nothing usable is present or the value is outside the allowed band.
 */
export function parseRupees(input: string): number | null {
  const raw = input
    .toLowerCase()
    .replace(/₹|rs\.?|inr|rupees?|\/-/g, " ")
    .replace(/,/g, "")
    .trim();
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|l|k|thousand)?\b/);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? "";
  if (unit.startsWith("c")) n *= 10_000_000;
  else if (unit.startsWith("l")) n *= 100_000;
  else if (unit === "k" || unit === "thousand") n *= 1_000;
  n = Math.round(n);
  if (n < MIN_REQUESTED_LOAN || n > MAX_REQUESTED_LOAN) return null;
  return n;
}

export function formatRupees(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

