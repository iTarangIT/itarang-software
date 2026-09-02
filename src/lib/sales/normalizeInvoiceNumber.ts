/**
 * E-280 — fold an invoice number into a comparable key.
 *
 * This is the single guard against double-counting revenue, so it is worth
 * stating exactly what it defends.
 *
 * The Drive tree holds BOTH eras of invoice. Nov 2025 – Jul 2026 were generated
 * by Zoho and are therefore ALREADY rows in `zoho_invoices`; Aug 2026 onward
 * come from Vyapar and exist nowhere else. A full backfill was chosen over a
 * cutover date, so every Drive file from the Zoho era must be recognised as
 * something we already have — and the two sides spell the same invoice four
 * different ways:
 *
 *   zoho_invoices.invoice_number    ITD/202627/013     (slashes, zero-padded)
 *   the Drive filename              ITD_202627_013.pdf (underscores)
 *   a sibling in the same series    ITG_202627_36.pdf  (NOT zero-padded)
 *   what the model reads back       ITG/202627/041     (padding re-added)
 *
 * All four were observed live. The last one is the trap: the file is named
 * `ITG_202627_41.pdf` but the printed number on the page is `ITG/202627/041`,
 * so a comparison that folds separators alone still misses.
 *
 * Hence: fold separators AND strip leading zeros from purely numeric segments.
 *
 *   ITD/202627/013 → ITD|202627|13
 *   ITD_202627_013 → ITD|202627|13     ← matches, so the backfill skips it
 *   ITG_202627_41  → ITG|202627|41
 *   ITG/202627/041 → ITG|202627|41     ← matches
 *   ITG_202627_035 → ITG|202627|35
 *   ITG_202627_36  → ITG|202627|36     ← must NOT match the line above
 *
 * The last pair is the reason this is not simply "strip all non-alphanumerics":
 * that would turn 035 into 03536-adjacent mush and, worse, `ITG20262735` vs
 * `ITG20262736` happen to differ only in the final character, which is fine —
 * but `ITG_202627_035` and `ITG_202627_35` are the SAME invoice while
 * `ITG_202627_035` and `ITG_202627_36` are two DIFFERENT ones. Only
 * segment-wise numeric normalisation gets both right.
 *
 * Deliberately NOT tolerant of near-misses. A fuzzy match here would silently
 * drop a real invoice, which understates revenue in the direction nobody
 * questions. Near-misses are caught separately by the amount/date fingerprint
 * in driveSalesScan, which imports AND flags rather than dropping.
 */

/** Segment separators seen in the wild: / - _ whitespace . */
const SEPARATORS = /[\s./\-_\\|]+/;

/**
 * Returns a comparable key, or null when there is nothing usable to compare.
 *
 * Null is meaningful: it means "this invoice cannot be deduped by number", and
 * the caller must fall back to the amount/date fingerprint rather than treating
 * it as new.
 */
export function normalizeInvoiceNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;

  // Strip a trailing file extension before anything else — this is fed both the
  // printed number and, as a fallback, the Drive filename.
  const withoutExt = raw.trim().replace(/\.(pdf|jpe?g|png|webp|gif)$/i, "");
  if (!withoutExt) return null;

  const segments = withoutExt
    .toUpperCase()
    .split(SEPARATORS)
    .map((s) => s.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .map((s) => {
      // Purely numeric: drop leading zeros so 013 and 13 agree. Keep at least
      // one digit so "000" does not become "".
      if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, "");
      return s;
    });

  if (segments.length === 0) return null;
  return segments.join("|");
}

/**
 * True when two invoice numbers denote the same invoice.
 *
 * Both must normalise to something; a null on either side is "unknown", never
 * a match. Two invoices we cannot identify are not thereby the same invoice.
 */
export function sameInvoiceNumber(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = normalizeInvoiceNumber(a);
  const kb = normalizeInvoiceNumber(b);
  return ka != null && kb != null && ka === kb;
}
