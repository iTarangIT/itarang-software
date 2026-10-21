/**
 * Drive (Vyapar PDF) invoice lines → invoice_line_items (E-322), so batteries
 * sold count for invoices nobody has imported a Vyapar register for.
 *
 * Batteries to dealers is SUM(quantity) of HSN 8507 lines (invoiceLines.ts).
 * On prod, invoice_line_items was empty: its only writers were the weekly
 * Vyapar register import and a one-time Zoho backfill, neither ever run there,
 * so the sales dashboard read "0 batteries" beside ₹82 lakh of battery
 * invoices (6 Oct 2026). The Drive reader already reads each PDF's items table
 * (extractSalesInvoiceLines, tracker ID 72); this stores what it read in the
 * ledger the battery count uses.
 *
 * Read lines come from a vision model, so they are stored only when they
 * check out against the invoice itself (checkDriveLines):
 *   * they add up to the invoice's taxable value (linesAddUp), AND
 *   * on every line with a printed rate, quantity × rate = amount — a
 *     misread quantity can still add up, because the amount column is read
 *     independently of it;
 * OR every line has a price and Σ quantity × price adds up to the taxable
 * value (Vyapar's GST-inclusive Amount column — reconcileDriveLines).
 * A Vyapar register import outranks this: it replaces 'drive' lines with its
 * own, and lines it already wrote are never overwritten here.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { InvoiceLine } from "@/lib/sales/salesInvoiceLines";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { classFor, mappedItems, productFor } from "@/lib/sales/itemMap";
import { reconcileDriveLines, toLedgerRows } from "@/lib/sales/driveLedgerLinesRules";

export { checkDriveLines, reconcileDriveLines, toLedgerRows } from "@/lib/sales/driveLedgerLinesRules";

export type SaveLedgerResult =
    | { saved: true; lines: number; batteries: number }
    | { saved: false; reason: string };

/**
 * Store a Drive document's read lines as its invoice_line_items, replacing
 * earlier ones of the same source. A sale invoice ('drive') never touches an
 * invoice that has Vyapar register lines. A credit note ('credit', ID 71,
 * invoice_id = credit_notes.id) is stored negative (toLedgerRows sign -1).
 * Refuses lines that fail reconcileDriveLines — checked on the printed
 * (positive) amounts against the document's own taxable value.
 */
export async function saveDriveLedgerLines(
    invoiceId: string,
    lines: InvoiceLine[],
    subTotal: number | null | undefined,
    source: "drive" | "credit" = "drive",
): Promise<SaveLedgerResult> {
    if (!(await hasInvoiceLedgerTables())) return { saved: false, reason: "E-322 not applied" };
    const fit = reconcileDriveLines(lines, subTotal);
    if (!fit.ok) return { saved: false, reason: fit.reason };
    const rows = toLedgerRows(fit.lines, source === "credit" ? -1 : 1);

    return db.transaction(async (tx) => {
        if (source === "drive") {
            const vyapar = (await tx.execute(sql`
                SELECT 1 FROM invoice_line_items WHERE invoice_id = ${invoiceId} AND source = 'vyapar' LIMIT 1
            `)) as unknown as unknown[];
            if (vyapar.length > 0) return { saved: false as const, reason: "has Vyapar register lines" };
        }

        await tx.execute(sql`DELETE FROM invoice_line_items WHERE invoice_id = ${invoiceId} AND source = ${source}`);
        // ID 147 — an item already mapped in Invoice Ledger › Item mapping lands linked.
        const mapped = await mappedItems(tx);
        for (const r of rows) {
            const m = productFor(mapped, r.item_name);
            await tx.execute(sql`
                INSERT INTO invoice_line_items (source, invoice_id, line_no, item_name, hsn, product_class,
                                                asset_type, product_id, quantity, rate, amount_excl_gst)
                VALUES (${source}, ${invoiceId}, ${r.line_no}, ${r.item_name}, ${r.hsn}, ${classFor(m, r.product_class, r.hsn)},
                        ${m.asset_type}, ${m.product_id}, ${r.quantity}, ${r.rate}, ${r.amount_excl_gst})`);
        }
        const batteries = rows.filter((r) => r.product_class === "battery").reduce((s, r) => s + r.quantity, 0);
        return { saved: true as const, lines: rows.length, batteries };
    });
}
