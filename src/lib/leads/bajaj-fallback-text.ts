/**
 * E-264 / E-275 — Bajaj Finance fallback: the pure, client-safe half.
 *
 * Everything here is constants and string helpers with no I/O, so the dealer
 * portal's "use client" pages can import it without dragging `@/lib/db` into
 * the browser bundle. `bajaj-fallback.ts` re-exports all of it for server code
 * and adds the audit write (`recordNoPreferredPartner`).
 */

/** The nationally-available fallback. Not an NBFC row — we do not route to it. */
export const BAJAJ_FALLBACK = {
  name: "Bajaj Finance",
  salesManagerPhone: "9217619585",
} as const;

/**
 * E-275 — the value stored in `product_selections.external_lender` /
 * `loan_sanctions.external_lender` when the dealer takes the Bajaj card.
 * Stable id, not the display name, so a rename never breaks a lookup.
 */
export const BAJAJ_EXTERNAL_LENDER = "bajaj_finance" as const;
export type ExternalLenderId = typeof BAJAJ_EXTERNAL_LENDER;

/** Display name for an `external_lender` value; unknown ids echo back. */
export function externalLenderName(id: string | null | undefined): string | null {
  if (!id) return null;
  return id === BAJAJ_EXTERNAL_LENDER ? BAJAJ_FALLBACK.name : id;
}

/**
 * The "card" copy — identical on the web card and the WhatsApp bubble. The
 * dealer can CONTINUE with this lender: picking it sends the lead straight to
 * Step 5 (no NBFC assignment, no admin gate).
 */
export function bajajCardText(): string {
  return (
    `Reach out to your local Bajaj Sales Manager for any further details — ` +
    `you may contact ${BAJAJ_FALLBACK.salesManagerPhone}.`
  );
}

/**
 * E-275 — what the dealer sees once the file is with an on-platform NBFC.
 * One constant for the web success screen and the WhatsApp bubble.
 */
export const NBFC_RECEIVED_MSG =
  "File received by NBFC. They will connect you within 1-2 hours.";

/**
 * The exact wording to show when no preferred partner covers the customer's
 * area. Kept here rather than inline so the web portal and WhatsApp cannot
 * drift into telling the same customer two different things.
 */
export function bajajFallbackMessage(): string {
  return (
    `🏦 *${BAJAJ_FALLBACK.name} is available in your area.*\n\n` +
    `Reach out to your local Bajaj Sales Manager for any further details — ` +
    `you may contact *${BAJAJ_FALLBACK.salesManagerPhone}*.`
  );
}
