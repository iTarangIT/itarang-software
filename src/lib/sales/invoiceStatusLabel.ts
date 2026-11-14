// Invoice status in words for every screen (ID 215; C27 wording audit, 2 Nov: sentence case,
// plain words, no ALL CAPS). The stored codes do not change. Client-safe.

export const INVOICE_STATUS_LABEL: Readonly<Record<string, string>> = {
    draft: "Draft",
    sent: "Sent",
    overdue: "Overdue",
    paid: "Paid",
    partially_paid: "Partly paid",
    void: "Void",
    credit_note: "Credit note",
};

/** "partially_paid" → "Partly paid"; an unlisted code still reads as words. */
export function invoiceStatusLabel(status: string | null | undefined): string {
    if (!status) return "No status";
    return INVOICE_STATUS_LABEL[status] ?? (status.charAt(0).toUpperCase() + status.slice(1)).replace(/_/g, " ");
}
