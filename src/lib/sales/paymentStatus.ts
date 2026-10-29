// ID 200 — one rule for an invoice's payment status, whoever sets the amount:
// the CEO's Payment button (api/dashboard/ceo/invoices/[id]/payment) and the
// Vyapar register's "Received/Paid Amount" (vyaparImport). Pure.

/** Half a paisa, so a floating-point round trip never leaves a settled invoice part-paid. */
export const PAYMENT_TOLERANCE = 0.005;

export type PaymentStatus = "sent" | "partially_paid" | "paid";

/** The status for `amountPaid` collected against `total` (both rupees). */
export function paymentStatusFor(amountPaid: number, total: number): PaymentStatus {
    if (amountPaid <= 0) return "sent";
    return amountPaid >= total - PAYMENT_TOLERANCE ? "paid" : "partially_paid";
}

/** Is `amountPaid` more than the invoice can take? An overpayment is a credit, not this invoice's balance. */
export function isOverpaid(amountPaid: number, total: number): boolean {
    return amountPaid > total + PAYMENT_TOLERANCE;
}
