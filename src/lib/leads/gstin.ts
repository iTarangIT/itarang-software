/**
 * GSTIN — the key that ties a dealer's invoices back to the CRM (review R-11).
 *
 * Invoices carry the customer's GSTIN; CRM leads now must carry it from the
 * moment they are marked Converted. revenueSource.ts matches the two with the
 * same normalisation in SQL (GSTIN_KEY): spaces removed, upper-cased.
 *
 * The format check is the standard 15-character shape — 2-digit state code,
 * 10-character PAN, entity number, 'Z', check character — the same pattern
 * the buyback vendor form already enforces. The check digit itself is not
 * verified: a typo that keeps the shape is caught when no invoice ever
 * matches, which the Sales Invoices reconciliation list shows.
 */

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/** Upper-case and strip all whitespace. '' stays ''. */
export function normalizeGstin(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

export function isValidGstin(value: string | null | undefined): boolean {
    return GSTIN_RE.test(normalizeGstin(value));
}
