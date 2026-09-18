/**
 * E-298 — the pure rules of the dealer payment-confirmation loop (no db), split
 * out so Vitest can assert them. See ./dealer-payment-confirmation.ts.
 *
 *   pending      → received | not_received
 *   not_received → received | not_received (updated remark / UTR)
 *   received     → final
 */
export type DealerPaymentStatus = "pending" | "received" | "not_received";

/** May a sanction whose dealer_payment_status is `current` take the dealer's answer? */
export function canRecordDealerPayment(current: string | null | undefined): boolean {
  return current === "pending" || current === "not_received";
}
