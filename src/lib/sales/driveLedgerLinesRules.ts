/**
 * Pure rules for storing Drive (Vyapar PDF) invoice lines in invoice_line_items
 * — see ./driveLedgerLines.ts for the why. No db import, so it is unit-tested.
 */
import { classifyHsn, normalizeHsn, type ProductClass } from "@/lib/sales/invoiceLines";
import { linesAddUp, type InvoiceLine } from "@/lib/sales/salesInvoiceLines";

/** Per-line qty × rate tolerance: rounding on the printed rate, never a wrong unit count. */
const ARITH_TOLERANCE_PCT = 1;
const ARITH_TOLERANCE_MIN = 2;

export type LineCheck = { ok: true } | { ok: false; reason: string };

export function checkDriveLines(lines: InvoiceLine[], subTotal: number | null | undefined): LineCheck {
    if (lines.length === 0) return { ok: false, reason: "no item rows read" };
    if (!linesAddUp(lines, subTotal)) {
        const sum = lines.reduce((s, l) => s + l.amount, 0);
        return { ok: false, reason: `lines do not add up (${sum.toFixed(2)} vs taxable ${subTotal ?? "?"})` };
    }
    for (const l of lines) {
        if (l.rate == null) continue;
        const expected = l.quantity * l.rate;
        if (Math.abs(expected - l.amount) > Math.max(ARITH_TOLERANCE_MIN, (l.amount * ARITH_TOLERANCE_PCT) / 100)) {
            return {
                ok: false,
                reason: `line ${l.line_no}: quantity ${l.quantity} × rate ${l.rate} ≠ amount ${l.amount}`,
            };
        }
    }
    return { ok: true };
}

export type LedgerRow = {
    line_no: number;
    item_name: string;
    hsn: string | null;
    product_class: ProductClass;
    quantity: number;
    rate: number | null;
    amount_excl_gst: number;
};

export function toLedgerRows(lines: InvoiceLine[]): LedgerRow[] {
    return lines.map((l) => ({
        line_no: l.line_no,
        item_name: l.description,
        hsn: normalizeHsn(l.hsn_code),
        product_class: classifyHsn(l.hsn_code),
        quantity: l.quantity,
        rate: l.rate,
        amount_excl_gst: l.amount,
    }));
}
