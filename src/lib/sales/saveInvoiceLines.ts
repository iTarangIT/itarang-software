/**
 * Store a sales invoice's line items and keep the item → product mapping
 * seeded (tracker ID 72, E-326).
 *
 * Everything here is best-effort from the scanner's point of view: the invoice
 * row is already saved, and a database without E-326 simply has no lines.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { extractSalesInvoiceLines } from "@/lib/ai/invoices/extractSalesInvoiceLines";
import { cleanInvoiceLines, linesAddUp, parseVoltAh, type InvoiceLine } from "@/lib/sales/salesInvoiceLines";
import { saveDriveLedgerLines } from "@/lib/sales/driveLedgerLines";

export type StoredLines = { lines: InvoiceLine[]; addUp: boolean };

/**
 * The product an item name most likely is: same voltage and Ah, the one with
 * the most costed stock first. A proposal only — stored as auto_matched so the
 * mapping screen shows it for confirmation.
 */
async function proposeProduct(description: string): Promise<string | null> {
  const spec = parseVoltAh(description);
  if (!spec) return null;
  const rows = (await db.execute<{ id: string }>(sql`
    SELECT p.id
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id AND i.inventory_amount > 0
     WHERE p.voltage_v = ${spec.voltage} AND p.capacity_ah = ${spec.capacity}
     GROUP BY p.id
     ORDER BY COUNT(i.id) DESC, p.id
     LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Replace the invoice's lines with `lines` and seed a mapping row per new item. */
export async function saveInvoiceLines(invoiceId: string, lines: InvoiceLine[], source = "drive"): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM sales_invoice_lines WHERE sales_invoice_id = ${invoiceId}::uuid`);
    for (const l of lines) {
      await tx.execute(sql`
        INSERT INTO sales_invoice_lines
          (source, sales_invoice_id, line_no, description, item_key, hsn_code, quantity, rate, amount)
        VALUES
          (${source}, ${invoiceId}::uuid, ${l.line_no}, ${l.description}, ${l.item_key}, ${l.hsn_code},
           ${l.quantity}, ${l.rate}, ${l.amount})
      `);
    }
  });

  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.item_key || seen.has(l.item_key)) continue;
    seen.add(l.item_key);
    const existing = (await db.execute<{ item_key: string }>(sql`
      SELECT item_key FROM sales_invoice_item_products WHERE item_key = ${l.item_key} LIMIT 1
    `)) as unknown as { item_key: string }[];
    if (existing.length > 0) continue;
    const productId = await proposeProduct(l.description);
    await db.execute(sql`
      INSERT INTO sales_invoice_item_products (item_key, item_name, product_id, auto_matched)
      VALUES (${l.item_key}, ${l.description}, ${productId}::uuid, ${productId != null})
      ON CONFLICT (item_key) DO NOTHING
    `);
  }
}

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

/** Read and store. Lines that do not add up are stored too — the margin query ignores them. */
export async function readAndSaveInvoiceLines(
  invoiceId: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  subTotal: number | null,
): Promise<StoredLines> {
  const read = await readInvoiceLines(buffer, mimeType, fileName, subTotal);
  await saveInvoiceLines(invoiceId, read.lines);
  // Same read, into the E-322 ledger the batteries-sold count uses — only when
  // it checks out against the invoice (driveLedgerLines.ts). Best-effort: a
  // failure here costs the battery count for this invoice, never the scan.
  try {
    const ledger = await saveDriveLedgerLines(invoiceId, read.lines, subTotal);
    if (!ledger.saved) console.warn(`[sales-scan] ledger lines not stored for ${fileName}: ${ledger.reason}`);
  } catch (e) {
    console.warn(`[sales-scan] ledger lines failed for ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return read;
}
