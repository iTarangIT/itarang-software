/**
 * Backfill invoice_line_items (E-322) for Drive sales invoices — so "Batteries
 * to dealers" counts invoices nobody imported a Vyapar register for.
 *
 * On prod (6 Oct 2026) invoice_line_items was EMPTY, so the sales dashboard
 * read 0 batteries beside ₹82 lakh of battery invoices. New invoices now get
 * lines from the Drive scan (saveInvoiceLines → saveDriveLedgerLines); this
 * reads the existing ones. Each PDF's items table is read by the same model
 * call the scan uses, and stored ONLY when it checks out against the invoice:
 * lines add up to the taxable value AND quantity × rate = amount per line
 * (driveLedgerLinesRules.ts). Anything else is listed, never written.
 *
 * Usage (DATABASE_URL picks the database; Drive + OpenAI keys from .env.local):
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-line-items.ts            # dry run: reads, writes nothing
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-line-items.ts --commit
 *   … --id=ITG/202627/067     one invoice
 *   … --max=5                 stop after N invoices
 * For prod: export DATABASE_URL from .env.production first (an exported value
 * wins over --env-file).
 *
 * Resumable: an invoice that already has lines (any source) is skipped. A read
 * is a paid model call, so the dry run costs the same as --commit.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { downloadFile } from "@/lib/google/drive";
import { readInvoiceLines } from "@/lib/sales/saveInvoiceLines";
import { checkDriveLines, saveDriveLedgerLines } from "@/lib/sales/driveLedgerLines";
import { classifyHsn } from "@/lib/sales/invoiceLines";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ONLY = opt("id");
const MAX = opt("max") ? Number(opt("max")) : Infinity;

type Inv = { id: string; invoice_number: string; invoice_date: string; total: string; sub_total: string | null; drive_file_id: string; file_name: string };

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x").host.split(".")[0];
    console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} against ${host}`);

    const todo = (await db.execute(sql`
        SELECT si.id::text AS id, si.invoice_number, si.invoice_date::text AS invoice_date,
               si.total::text AS total, si.sub_total::text AS sub_total, si.drive_file_id, si.file_name
          FROM sales_invoices si
         WHERE si.drive_file_id IS NOT NULL
           AND (si.status IS NULL OR si.status <> 'void')
           AND NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = si.id::text)
           ${ONLY ? sql`AND si.invoice_number = ${ONLY}` : sql``}
         ORDER BY si.invoice_date DESC, si.invoice_number
    `)) as unknown as Inv[];
    console.log(`${todo.length} invoice(s) without lines${Number.isFinite(MAX) ? ` (max ${MAX})` : ""}\n`);

    let stored = 0, rejected = 0, failed = 0, batteries = 0;
    for (const inv of todo.slice(0, MAX)) {
        const sub = inv.sub_total == null ? null : Number(inv.sub_total);
        try {
            const buf = await downloadFile(inv.drive_file_id);
            const { lines } = await readInvoiceLines(buf, "application/pdf", inv.file_name, sub);
            const check = checkDriveLines(lines, sub);
            const bat = lines.filter((l) => classifyHsn(l.hsn_code) === "battery").reduce((s, l) => s + l.quantity, 0);
            const desc = lines.map((l) => `${l.quantity}× ${l.description.slice(0, 40)} [${l.hsn_code ?? "-"}]`).join(" | ");
            if (!check.ok) {
                rejected++;
                console.log(`✘ ${inv.invoice_number} ${inv.invoice_date} taxable ${sub} — ${check.reason}\n    read: ${desc || "(nothing)"}`);
                continue;
            }
            if (COMMIT) {
                const r = await saveDriveLedgerLines(inv.id, lines, sub);
                if (!r.saved) {
                    rejected++;
                    console.log(`✘ ${inv.invoice_number} not stored — ${r.reason}`);
                    continue;
                }
            }
            stored++;
            batteries += bat;
            console.log(`✔ ${inv.invoice_number} ${inv.invoice_date} ${lines.length} line(s), ${bat} batteries — ${desc}`);
        } catch (e) {
            failed++;
            console.log(`! ${inv.invoice_number} failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    console.log(
        `\n${COMMIT ? "stored" : "would store"} ${stored} · rejected ${rejected} · failed ${failed} · batteries ${batteries}`,
    );
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
