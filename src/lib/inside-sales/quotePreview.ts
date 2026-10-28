/**
 * The GST preview a salesperson sees before saving a quotation, and the
 * summary table in the CEO approval email.
 *
 * Pure — the same per-line arithmetic as the PDF (quote-pdf/tax.ts: line GST
 * rounded to paise), but one GST figure rather than the IGST / CGST+SGST split:
 * the split needs the dealer's place of supply, which the form does not have,
 * and the two total identically. The document still prints the split.
 */
import type { CommercialsProductLine } from "./types";
import { lineGstAmount, toPaise } from "@/lib/leads/quote-pdf/tax";

export type QuotePreviewLine = {
    line: CommercialsProductLine;
    amount: number | null;
    gstRatePct: number | null;
    gst: number | null;
};

export type QuotePreview = {
    lines: QuotePreviewLine[];
    subTotal: number;
    gstTotal: number;
    total: number;
    /** A priced line with no known GST rate — its GST is not in gstTotal. */
    hasUnsetGst: boolean;
    /** A line with no unit price yet. */
    hasUnpriced: boolean;
};

export function buildQuotePreview(
    lines: CommercialsProductLine[],
    rateFor: (l: CommercialsProductLine) => number | null | undefined,
): QuotePreview {
    let subTotal = 0;
    let gstTotal = 0;
    let hasUnsetGst = false;
    let hasUnpriced = false;
    const out = lines.map((line): QuotePreviewLine => {
        const rawRate = rateFor(line);
        const gstRatePct = rawRate != null && Number.isFinite(rawRate) ? rawRate : null;
        if (line.unit_price == null || !Number.isFinite(line.unit_price)) {
            hasUnpriced = true;
            return { line, amount: null, gstRatePct, gst: null };
        }
        const amount = toPaise(line.unit_price * line.quantity);
        const gst = lineGstAmount(amount, gstRatePct);
        subTotal += amount;
        if (gst == null) hasUnsetGst = true;
        else gstTotal += gst;
        return { line, amount, gstRatePct, gst };
    });
    subTotal = toPaise(subTotal);
    gstTotal = toPaise(gstTotal);
    return { lines: out, subTotal, gstTotal, total: toPaise(subTotal + gstTotal), hasUnsetGst, hasUnpriced };
}
