/**
 * Pure helpers about a quotation's identity: which financial year it falls in,
 * and what its document is called.
 *
 * Split out of quoteDraft.ts / quoteDispatch.ts for the same reason ./config is
 * split from ./config-store — both of those modules import the database, and
 * these two functions are the parts worth testing without one.
 */

/**
 * The Indian financial year an instant falls in, as its starting year.
 *
 * April–March, so 13 Aug 2026 is FY 2026 and 3 Feb 2027 is still FY 2026.
 * Computed in IST because that is the year the business is in — a quote raised
 * at 06:00 IST on 1 April belongs to the new FY even though it is still 31
 * March in UTC.
 */
export function financialYear(d: Date): number {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  // getUTCMonth is 0-based, so 3 is April.
  return ist.getUTCMonth() >= 3 ? year : year - 1;
}

/**
 * The filename the dealer sees, and the storage key the document is written to.
 *
 * The quote number is the thing a dealer quotes back over the phone, so it is
 * the name. Sanitised because it also becomes a storage key: an unfiltered
 * number containing a slash or a `..` would write outside the quotations
 * folder.
 */
export function quotationFileName(quoteNumber: string): string {
  return `${quoteNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

/** Strip any "-R3" suffix, leaving the root that a revision chain shares. */
export function quoteNumberRoot(quoteNumber: string): string {
  return quoteNumber.replace(/-R\d+$/, "");
}
