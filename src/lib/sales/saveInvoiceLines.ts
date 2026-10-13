/**
 * Read a Drive sales invoice's line items and store them in the one line
 * store, invoice_line_items (E-322, driveLedgerLines.ts).
 *
 * ID 147: the scan used to write the older E-326 store (sales_invoice_lines)
 * FIRST. Prod never had those tables, so that write threw and the ledger save
 * after it never ran — Drive lines reached nobody. Nothing reads E-326 any
 * more (gross margin and By SKU read invoice_line_items), so it is not written.
 *
 * Best-effort from the scanner's point of view: the invoice row is already saved.
 */

import { extractSalesInvoiceLines } from "@/lib/ai/invoices/extractSalesInvoiceLines";
import { cleanInvoiceLines, linesAddUp, type InvoiceLine } from "@/lib/sales/salesInvoiceLines";
import { saveDriveLedgerLines } from "@/lib/sales/driveLedgerLines";

export type StoredLines = { lines: InvoiceLine[]; addUp: boolean };

/** Read the lines off the file. Nothing is written. */
export async function readInvoiceLines(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  subTotal: number | null,
): Promise<StoredLines> {
  const lines = cleanInvoiceLines(await extractSalesInvoiceLines(buffer, mimeType, fileName));
  return { lines, addUp: linesAddUp(lines, subTotal) };
}

/**
 * Read and store in the ledger — only lines that check out
 * (driveLedgerLines.reconcileDriveLines). `source` 'credit' is a credit note
 * (ID 71): same items table, stored negative under the credit_notes id.
 */
export async function readAndSaveInvoiceLines(
  invoiceId: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  subTotal: number | null,
  source: "drive" | "credit" = "drive",
): Promise<StoredLines> {
  const read = await readInvoiceLines(buffer, mimeType, fileName, subTotal);
  // Into the E-322 ledger that batteries sold, By SKU and gross margin read —
  // only when it checks out against the invoice (driveLedgerLines.ts).
  // Best-effort: a failure here costs this invoice's lines, never the scan.
  try {
    const ledger = await saveDriveLedgerLines(invoiceId, read.lines, subTotal, source);
    if (!ledger.saved) console.warn(`[sales-scan] ledger lines not stored for ${fileName}: ${ledger.reason}`);
  } catch (e) {
    console.warn(`[sales-scan] ledger lines failed for ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return read;
}
