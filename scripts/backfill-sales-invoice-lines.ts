// Read the line items of Drive sales invoices already in the database
// (tracker ID 72, E-326). New invoices get theirs at scan time; this covers
// the ones imported before that.
//
//   node --import tsx --env-file=.env.local scripts/backfill-sales-invoice-lines.ts            # dry run
//   node --import tsx --env-file=.env.local scripts/backfill-sales-invoice-lines.ts --apply    # write
//   … --limit 5        only the first N invoices
//   … --redo           also invoices that already have lines
//
// A dry run still calls the model (one call per invoice) and prints what it
// read and whether the lines add up to the invoice's taxable value; it writes
// nothing. Requires E-326 and OPENAI_API_KEY.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { downloadFile } from "@/lib/google/drive";
import { grossMarginTablesPresent } from "@/lib/dashboard/grossMargin";
import { readInvoiceLines, saveInvoiceLines } from "@/lib/sales/saveInvoiceLines";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const REDO = args.includes("--redo");
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) || 0 : 0;

type Row = { id: string; invoice_number: string | null; file_name: string | null; drive_file_id: string; sub_total: string | null };

function sniffMime(buffer: Buffer): string {
    if (buffer.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
    return "application/pdf";
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  mode: ${APPLY ? "APPLY" : "dry run"}`);
    if (!(await grossMarginTablesPresent())) {
        console.log("E-326 is not applied on this database — nothing to do.");
        process.exit(1);
    }

    const rows = (await db.execute<Row>(sql`
        SELECT si.id, si.invoice_number, si.file_name, si.drive_file_id, si.sub_total
          FROM sales_invoices si
         WHERE si.drive_file_id IS NOT NULL
           AND si.status IS DISTINCT FROM 'void'
           ${REDO ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM sales_invoice_lines l WHERE l.sales_invoice_id = si.id)`}
         ORDER BY si.invoice_date DESC NULLS LAST
         ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}
    `)) as unknown as Row[];
    console.log(`${rows.length} invoice(s) to read.\n`);

    let ok = 0;
    let mismatch = 0;
    let failed = 0;
    for (const r of rows) {
        const label = `${r.invoice_number ?? "(no number)"}  ${r.file_name ?? ""}`;
        try {
            const buffer = await downloadFile(r.drive_file_id);
            const subTotal = r.sub_total == null ? null : Number(r.sub_total);
            const read = await readInvoiceLines(buffer, sniffMime(buffer), r.file_name ?? "", subTotal);
            const sum = read.lines.reduce((s, l) => s + l.amount, 0);
            console.log(`${read.addUp ? "OK      " : "MISMATCH"}  ${label}  lines=${read.lines.length}  sum=${sum.toFixed(2)}  sub_total=${r.sub_total ?? "—"}`);
            for (const l of read.lines) {
                console.log(`            ${l.quantity} × ${l.description}  [HSN ${l.hsn_code ?? "—"}]  ${l.amount.toFixed(2)}`);
            }
            if (read.addUp) ok++;
            else mismatch++;
            if (APPLY && read.lines.length > 0) await saveInvoiceLines(r.id, read.lines);
        } catch (e) {
            failed++;
            console.log(`FAILED    ${label}  ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    console.log(`\n${ok} add up, ${mismatch} do not (stored but ignored by the margin), ${failed} failed.`);
    if (!APPLY) console.log("Dry run — nothing was written. Re-run with --apply to store the lines.");
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
