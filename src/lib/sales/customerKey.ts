/**
 * E-280 — fold a customer name enough to compare it across the two sources.
 *
 * Used only by the duplicate-detection fingerprint in driveSalesScan. It lives
 * in its own module because that one imports the database, and the repo's test
 * scope is deliberately pure, no-I/O helpers.
 *
 * "HAKIM ALI AUTO SALES AND SERVICE" and "Hakim Ali Auto Sales & Service" are
 * the same dealer: case, punctuation, the and/& spelling and the company-form
 * suffix all vary between what Zoho stored and what the model reads off the
 * page.
 *
 * This has to be neither too loose nor too tight. Too loose folds two dealers
 * together and a real invoice is flagged as a duplicate of somebody else's;
 * too tight and a genuine re-read slips through unflagged. The live data sets
 * the bar: five DIFFERENT dealers were each invoiced ₹12,980 on 2026-03-31, so
 * the customer is the only thing separating those five invoices.
 */
export function customerKey(name: string | null | undefined): string | null {
  if (!name) return null;
  // The word boundaries are load-bearing: without them "CO" matches inside
  // "GLOBAL MOTOCORP" and two unrelated dealers fold to the same key.
  const k = name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|M\/S)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
  return k || null;
}
