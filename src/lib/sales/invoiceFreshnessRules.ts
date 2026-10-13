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
};

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
