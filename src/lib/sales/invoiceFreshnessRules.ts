/**
 * ID 171 — how fresh the invoice data is. CLIENT-SAFE, pure: the caption
 * under revenue / battery numbers, the daily email line and the Admin alert
 * all read these. The data half is ./invoiceFreshness.ts.
 *
 * "Read up to" = the date of the latest invoice the CRM has (non-void).
 * "Stale" = no NEW invoice read for `stale_after` working days (office
 * calendar, ID 85; the limit is the `invoice_stale_days` time limit).
 */

export type InvoiceFreshness = {
    /** Invoice date of the latest non-void invoice, YYYY-MM-DD. */
    read_up_to: string | null;
    /** When the latest new invoice was read into the CRM (ISO). */
    last_read_at: string | null;
    /** Working days since then (0 = today). */
    working_days_since_read: number | null;
    /** The limit in force (working days). */
    stale_after: number;
    stale: boolean;
    /**
     * ID 200 — when an invoice's amount paid last changed (the CEO's Payment
     * button or a Vyapar register upload), ISO; null when never.
     */
    last_payment_at?: string | null;
    /**
     * Payment sync — the "Generated on" of the newest Vyapar Sale Report
     * imported (ISO): the payments on Drive / Vyapar invoices are true as of it.
     */
    payments_as_of?: string | null;
};

/** ID 200 — where the Accounts Receivable figure comes from, said under the figure. */
export const RECEIVABLES_SOURCE =
    "From old Zoho invoices, Drive invoice PDFs and the Vyapar register. Payments come from the weekly Vyapar " +
    "Sale Report; old Zoho invoices from Zoho and payments entered on them.";

/**
 * RECEIVABLES_SOURCE plus "Payments as of the Vyapar export of <IST time>." —
 * else "Payments updated <IST time>." — when known.
 */
export function receivablesSourceText(f: InvoiceFreshness | null | undefined): string {
    if (f?.payments_as_of) return `${RECEIVABLES_SOURCE} Payments as of the Vyapar export of ${istStamp(f.payments_as_of)}.`;
    const at = f?.last_payment_at;
    if (!at) return RECEIVABLES_SOURCE;
    return `${RECEIVABLES_SOURCE} Payments updated ${istStamp(at)}.`;
}

/** ID 200 (Kartik, 2 Nov): Finance uploads the Sale Report every Monday; red after this many days without one. */
export const PAYMENTS_STALE_DAYS = 8;

/**
 * ID 200 — are the Vyapar payments out of date? True when no Sale Report has
 * been imported, or the newest export is more than PAYMENTS_STALE_DAYS old.
 */
export function paymentsStale(f: InvoiceFreshness | null | undefined, now: Date = new Date()): boolean {
    if (!f) return false; // still loading: no red flash
    if (!f.payments_as_of) return true;
    return now.getTime() - new Date(f.payments_as_of).getTime() > PAYMENTS_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/** The red line under the figure when paymentsStale(); null otherwise. */
export function paymentsStaleText(f: InvoiceFreshness | null | undefined, now: Date = new Date()): string | null {
    if (!paymentsStale(f, now)) return null;
    if (!f?.payments_as_of) return "No Vyapar Sale Report uploaded yet: Drive and Vyapar invoices count as unpaid.";
    const days = Math.floor((now.getTime() - new Date(f.payments_as_of).getTime()) / (24 * 60 * 60 * 1000));
    return `No Vyapar Sale Report for ${days} days: payments may be out of date.`;
}

function istStamp(at: string): string {
    return new Date(at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

export function isStale(workingDaysSinceRead: number | null, staleAfter: number): boolean {
    return workingDaysSinceRead == null || workingDaysSinceRead >= staleAfter;
}

export function fmtDay(d: string | null): string {
    if (!d) return "—";
    return new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });
}

/** "Invoices read up to 9 Oct 2026" (+ the staleness when stale). */
export function readUpToText(f: InvoiceFreshness): string {
    if (!f.read_up_to) return "No invoices read yet";
    const base = `Invoices read up to ${fmtDay(f.read_up_to)}`;
    return f.stale ? `${base} · no new invoice for ${staleSpan(f)}` : base;
}

/** "4 working days" / "a while" — for the stale wording. */
export function staleSpan(f: InvoiceFreshness): string {
    const n = f.working_days_since_read;
    return n == null ? "a while" : `${n} working day${n === 1 ? "" : "s"}`;
}

/** The Admin alert / email line, or null when fresh. */
export function staleAlertText(f: InvoiceFreshness): string | null {
    if (!f.stale) return null;
    const last = f.last_read_at ? fmtDay(f.last_read_at.slice(0, 10)) : "never";
    return `No new invoice read for ${staleSpan(f)} (last read ${last}; latest invoice dated ${fmtDay(f.read_up_to)}). Check the Drive sales folders and the Vyapar export.`;
}
