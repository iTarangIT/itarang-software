/**
 * Backfill invoice_line_items (E-322) for Drive sales invoices — so "Batteries
 * to dealers" counts invoices nobody imported a Vyapar register for.
 *
 * On prod (6 Oct 2026) invoice_line_items was EMPTY, so the sales dashboard
 * read 0 batteries beside ₹82 lakh of battery invoices. New invoices now get
 * lines from the Drive scan (readAndSaveInvoiceLines → saveDriveLedgerLines); this
 * reads the existing ones. Each PDF's items table is read by the same model
 * call the scan uses, and stored ONLY when it checks out against the invoice:
 * lines add up to the taxable value AND quantity × rate = amount per line
 * (driveLedgerLinesRules.ts). Anything else is listed, never written.
 *
 * Usage (DATABASE_URL picks the database; Drive + OpenAI keys from .env.local):
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-line-items.ts            # dry run: reads, writes nothing
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-line-items.ts --commit
 *   … --credit-notes          credit notes instead of invoices (ID 71): their
 *                             items table, stored NEGATIVE as source 'credit'
 *                             so batteries sold, By SKU and gross margin net them
 *   … --id=ITG/202627/067     one invoice (or credit note number)
 *   … --max=5                 stop after N invoices
 *   … --retries=2             re-read an invoice whose lines fail the check
 *                             (default 2). The model sometimes returns
 *                             GST-inclusive row amounts; a re-read usually
 *                             returns the taxable ones. Nothing is stored
 *                             unless one read passes.
 * For prod: export DATABASE_URL from .env.production first (an exported value
 * wins over --env-file).
 *
 * Resumable: an invoice that already has lines (any source) is skipped. A read
 * is a paid model call, so the dry run costs the same as --commit.
 *
 * Recorded (ID 71): every --commit run writes one invoice_imports row
 * (kind 'credit_lines_fill' / 'invoice_lines_fill') with what it stored,
 * rejected and failed, so "has the fill-in run happened?" has an answer
 * (Invoice Ledger › Invoices shows the last one; verify-id71-credit-notes.ts
 * checks it).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { downloadFile } from "@/lib/google/drive";
import { getObject } from "@/lib/storage/s3";
import { readInvoiceLines } from "@/lib/sales/saveInvoiceLines";
import { reconcileDriveLines, saveDriveLedgerLines } from "@/lib/sales/driveLedgerLines";
import { classifyHsn } from "@/lib/sales/invoiceLines";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const CREDIT = args.includes("--credit-notes");
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ONLY = opt("id");
const MAX = opt("max") ? Number(opt("max")) : Infinity;
const RETRIES = opt("retries") ? Number(opt("retries")) : 2;

type Inv = { id: string; invoice_number: string; invoice_date: string; total: string; sub_total: string | null; drive_file_id: string; file_name: string; storage_key: string | null };

/**
 * The PDF from Drive, else the copy the scan stored at import (storage_key) —
 * a file moved or deleted in Drive since (ITD/202627/026: Drive 404) is still
 * the invoice the revenue figure counts.
 */
async function fetchPdf(inv: Inv): Promise<Buffer> {
    try {
        return await downloadFile(inv.drive_file_id);
    } catch (e) {
        if (!inv.storage_key) throw e;
        const copy = await getObject("documents", inv.storage_key);
        if (!copy) throw e;
        console.log(`    (not in Drive any more — read the stored copy ${inv.storage_key})`);
        return copy;
    }
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x").host.split(".")[0];
    console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} against ${host}`);

    const todo = (await db.execute(CREDIT ? sql`
        SELECT cn.id::text AS id, cn.note_number AS invoice_number, cn.issue_date::text AS invoice_date,
               cn.total::text AS total, cn.sub_total::text AS sub_total, cn.drive_file_id, cn.file_name,
               NULL::text AS storage_key
          FROM credit_notes cn
         WHERE cn.drive_file_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'credit' AND v.invoice_id = cn.id::text)
           AND NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.source = 'credit' AND l.invoice_id = cn.id::text)
           ${ONLY ? sql`AND cn.note_number = ${ONLY}` : sql``}
         ORDER BY cn.issue_date DESC, cn.note_number
    ` : sql`
        SELECT si.id::text AS id, si.invoice_number, si.invoice_date::text AS invoice_date,
               si.total::text AS total, si.sub_total::text AS sub_total, si.drive_file_id, si.file_name, si.storage_key
          FROM sales_invoices si
         WHERE si.drive_file_id IS NOT NULL
           AND (si.status IS NULL OR si.status <> 'void')
           AND NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = si.id::text)
           ${ONLY ? sql`AND si.invoice_number = ${ONLY}` : sql``}
         ORDER BY si.invoice_date DESC, si.invoice_number
    `)) as unknown as Inv[];
    console.log(`${todo.length} ${CREDIT ? "credit note" : "invoice"}(s) without lines${Number.isFinite(MAX) ? ` (max ${MAX})` : ""}\n`);

    let stored = 0, rejected = 0, failed = 0, batteries = 0;
    const storedNumbers: string[] = [];
    const rejectedNumbers: string[] = [];
    for (const inv of todo.slice(0, MAX)) {
        const sub = inv.sub_total == null ? null : Number(inv.sub_total);
        try {
            const buf = await fetchPdf(inv);
            let { lines } = await readInvoiceLines(buf, "application/pdf", inv.file_name, sub);
            let check = reconcileDriveLines(lines, sub);
            for (let attempt = 1; !check.ok && attempt <= RETRIES; attempt++) {
                ({ lines } = await readInvoiceLines(buf, "application/pdf", inv.file_name, sub));
                check = reconcileDriveLines(lines, sub);
            }
            const bat = lines.filter((l) => classifyHsn(l.hsn_code) === "battery").reduce((s, l) => s + l.quantity, 0);
            const desc = lines.map((l) => `${l.quantity}× ${l.description.slice(0, 40)} [${l.hsn_code ?? "-"}]`).join(" | ");
            if (!check.ok) {
                rejected++;
                rejectedNumbers.push(inv.invoice_number);
                console.log(`✘ ${inv.invoice_number} ${inv.invoice_date} taxable ${sub} — ${check.reason}\n    read: ${desc || "(nothing)"}`);
                continue;
            }
            if (COMMIT) {
                const r = await saveDriveLedgerLines(inv.id, lines, sub, CREDIT ? "credit" : "drive");
                if (!r.saved) {
                    rejected++;
                    rejectedNumbers.push(inv.invoice_number);
                    console.log(`✘ ${inv.invoice_number} not stored — ${r.reason}`);
                    continue;
                }
            }
            stored++;
            storedNumbers.push(inv.invoice_number);
            if (check.basis === "qty_x_rate") console.log(`    (amounts were GST-inclusive; taxable rebuilt from quantity × price)`);
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
    if (COMMIT && todo.length) {
        // ID 71: the run is recorded, not just printed.
        const summary = JSON.stringify({
            stored,
            rejected,
            failed,
            batteries,
            only: ONLY,
            stored_numbers: storedNumbers.slice(0, 500),
            rejected_numbers: rejectedNumbers.slice(0, 500),
        });
        await db.execute(sql`
            INSERT INTO invoice_imports (kind, file_name, summary)
            VALUES (${CREDIT ? "credit_lines_fill" : "invoice_lines_fill"}, 'scripts/backfill-drive-line-items.ts', ${summary}::jsonb)`);
        console.log(`recorded in invoice_imports (${CREDIT ? "credit_lines_fill" : "invoice_lines_fill"})`);
    }
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
