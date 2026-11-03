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

// ── Duplicate / updated detection (E-370) ──────────────────────────────────
//
// Business rules (3 Nov):
//   * Duplicate — same number, date and amount as what was last imported, and
//     nothing else changed → not imported again (no writes at all).
//   * Updated — same number (the number identifies the invoice; a different
//     date is a correction, not another invoice) but the amount, received,
//     balance, date, items or cancelled flag changed → update the existing
//     invoice, never create a second one.
//   * Payment validation — compared with the LAST IMPORTED row, not only the
//     CRM: received / balance changed → update; unchanged → skip.
//   * Vyapar always wins — Vyapar unchanged but the CRM differs (a payment
//     typed in by hand, a misread PDF total or date) → re-apply Vyapar
//     ("drift").

/** One document as Vyapar shows it (this file, or the last import). */
export type RegisterFacts = {
    date: string | null;
    total: number | null;
    received: number | null;
    balance: number | null;
    cancelled: boolean;
    /** linesHash() of its items; null when unknown (no item sheet, or an old snapshot). */
    lines_hash: string | null;
};

/**
 * The CRM's own record of the same document. `paid` = amount paid (invoice) or
 * used part (credit note). `has_register_lines` = its item lines already came
 * from a Vyapar register (false = only the Drive PDF's reading; undefined =
 * not known, e.g. a credit note).
 */
export type CrmFacts = { date: string | null; total: number | null; paid: number; voided: boolean; has_register_lines?: boolean };

export type RegisterChange = "amount" | "received" | "balance" | "date" | "lines" | "cancelled";
export type CrmDrift = "amount" | "paid" | "date" | "cancelled" | "lines";
export type Classification = "new" | "duplicate" | "updated";

export type RegisterVerdict = {
    classification: Classification;
    /** What changed in Vyapar since the last import (empty on the first import of a document). */
    changes: RegisterChange[];
    /** Where the CRM disagrees with Vyapar now — re-applied, Vyapar wins. */
    drift: CrmDrift[];
};

const AMOUNT_TOLERANCE = 1; // ₹1: Vyapar rounds totals, the PDF reader does not
const MONEY_TOLERANCE = 0.5;

const moneyDiffers = (a: number | null, b: number | null, tol = MONEY_TOLERANCE) =>
    a == null || b == null ? a !== b : Math.abs(a - b) > tol;
const dayOf = (d: string | null) => (d ? d.slice(0, 10) : null);

/**
 * Classify one register document. `crm` null = the CRM does not have it →
 * new. `last` null = never imported before (first upload after E-370): only
 * the CRM comparison applies, so an invoice already in step is a duplicate.
 * `expectedPaid` = what the CRM's amount paid should be after the upload
 * (registerPaidFor against the total it will have), null when the file has no
 * payment for it.
 */
export function classifyRegisterDoc(input: {
    doc: RegisterFacts;
    last: RegisterFacts | null;
    crm: CrmFacts | null;
    expectedPaid: number | null;
}): RegisterVerdict {
    const { doc, last, crm, expectedPaid } = input;
    if (!crm) return { classification: "new", changes: [], drift: [] };

    const changes: RegisterChange[] = [];
    if (last) {
        if (doc.total != null && moneyDiffers(doc.total, last.total, AMOUNT_TOLERANCE)) changes.push("amount");
        if (doc.received != null && moneyDiffers(doc.received, last.received)) changes.push("received");
        if (doc.balance != null && moneyDiffers(doc.balance, last.balance)) changes.push("balance");
        if (doc.date && dayOf(doc.date) !== dayOf(last.date)) changes.push("date");
        if (doc.lines_hash && last.lines_hash && doc.lines_hash !== last.lines_hash) changes.push("lines");
        if (doc.cancelled !== last.cancelled) changes.push("cancelled");
    }

    const drift: CrmDrift[] = [];
    if (doc.cancelled) {
        if (!crm.voided) drift.push("cancelled");
    } else if (!crm.voided) {
        if (doc.total != null && moneyDiffers(doc.total, crm.total, AMOUNT_TOLERANCE)) drift.push("amount");
        if (expectedPaid != null && moneyDiffers(expectedPaid, crm.paid)) drift.push("paid");
        if (doc.date && crm.date && dayOf(doc.date) !== dayOf(crm.date)) drift.push("date");
        // Vyapar's items replace the PDF reading once (batteries sold come from them).
        if (doc.lines_hash && crm.has_register_lines === false) drift.push("lines");
    }

    return { classification: changes.length || drift.length ? "updated" : "duplicate", changes, drift };
}

/** "ITG/202627/045" → "ITG" — the series an invoice belongs to (one per firm / state). */
export function invoiceSeries(number: string): string | null {
    const m = number.trim().toUpperCase().match(/^([A-Z]{2,})[/-]/);
    return m ? m[1] : null;
}
