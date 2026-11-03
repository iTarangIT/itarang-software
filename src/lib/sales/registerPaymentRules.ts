/**
 * Vyapar payment sync — the rules for applying a Sale Report's payments to the
 * CRM. PURE (no database) so they are unit tested; ./vyaparImport.ts applies
 * them.
 *
 * Vyapar is the source of truth for what a customer has paid. Every upload of
 * the Sale Report carries, per invoice, the TOTAL received so far ("Received/
 * Paid Amount") — an absolute figure, never an increment — so re-uploading the
 * same file, or two people uploading it, changes nothing, and a payment
 * reversed in Vyapar comes back down on the next upload.
 *
 *   * An invoice absent from the file is never touched (absence is not
 *     payment): the preview lists it so someone can check Vyapar.
 *   * An export older than the last one imported would roll payments back, so
 *     it is refused unless the person importing confirms it.
 *   * The amount paid is capped at the CRM's invoice total (an overpayment is a
 *     credit, not this invoice's balance) and is never negative.
 *   * A credit note's used part = its total less Vyapar's Balance Due.
 */
import { PAYMENT_TOLERANCE } from "./paymentStatus";

export type PaymentChange = "none" | "increase" | "decrease" | "no_data";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The amount paid the register sets: within [0, total]; null when the file has no payment for it. */
export function registerPaidFor(registerPaid: number | null | undefined, total: number): number | null {
    if (registerPaid == null || !Number.isFinite(registerPaid)) return null;
    return r2(Math.min(Math.max(registerPaid, 0), Math.max(total, 0)));
}

/** How one invoice's amount paid moves on this upload. */
export function paymentChangeFor(before: number, after: number | null): PaymentChange {
    if (after == null) return "no_data";
    if (Math.abs(after - before) <= PAYMENT_TOLERANCE) return "none";
    return after > before ? "increase" : "decrease";
}

/**
 * The CRM total and the register total disagree by more than a rupee: the PDF
 * was mis-read or the invoice was edited in Vyapar after it was filed. The
 * payment still applies (capped at the CRM total), but someone should look.
 */
export function totalsDisagree(crmTotal: number | null, registerTotal: number | null): boolean {
    if (crmTotal == null || registerTotal == null) return false;
    return Math.abs(crmTotal - registerTotal) > 1;
}

/**
 * Is `incoming` (this file's "Generated on") older than `last` (the newest
 * register already imported)? Unknown stamps never block — a file without one
 * can always be imported (the preview says it has no stamp).
 */
export function isOlderExport(incoming: string | null | undefined, last: string | null | undefined): boolean {
    if (!incoming || !last) return false;
    const a = Date.parse(incoming);
    const b = Date.parse(last);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return a < b;
}

/**
 * The date recorded as the invoice's last payment. Vyapar's Sale Report has no
 * payment dates, so a rise is dated to the export ("as of" — the payment was
 * made on or before it); an unchanged or lowered amount keeps the date it had;
 * nothing paid clears it.
 */
export function lastPaymentDateFor(
    change: PaymentChange,
    paidAfter: number | null,
    generatedAt: string | null | undefined,
    existing: string | null,
    today: string,
): string | null {
    if (paidAfter != null && paidAfter <= 0) return null;
    if (change === "increase") return generatedAt ? generatedAt.slice(0, 10) : today;
    return existing;
}

/** A credit note's used part: total less Vyapar's Balance Due, within [0, total]; null when the file has no balance. */
export function creditNoteAppliedFor(total: number | null, balanceDue: number | null | undefined): number | null {
    if (total == null || balanceDue == null || !Number.isFinite(balanceDue)) return null;
    return r2(Math.min(Math.max(total - balanceDue, 0), Math.max(total, 0)));
}

/** "ITG/202627/045" → "ITG" — the series an invoice belongs to (one per firm / state). */
export function invoiceSeries(number: string): string | null {
    const m = number.trim().toUpperCase().match(/^([A-Z]{2,})[/-]/);
    return m ? m[1] : null;
}
