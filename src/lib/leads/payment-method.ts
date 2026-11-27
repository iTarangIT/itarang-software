/**
 * Which payment methods send a customer file to the iTarang NBFCs (Step 4
 * lender choice, automatic lender selection, WhatsApp Step 4, loan-amount ask).
 *
 * 27 Nov 2026 — user decision: "Other Finance" is treated like "iTarang
 * Finance" FOR NOW, until the business confirms what Other Finance means.
 * If it turns out to mean an outside lender only, remove "other_finance"
 * from this set — this is the single switch for all of those places.
 */
export const NBFC_ROUTED_PAYMENT_METHODS: ReadonlySet<string> = new Set(["finance", "other_finance"]);

/** True when this file's loan goes through the iTarang NBFCs. */
export function routesToNbfc(paymentMethod: string | null | undefined): boolean {
  return NBFC_ROUTED_PAYMENT_METHODS.has(String(paymentMethod ?? "").trim().toLowerCase());
}
