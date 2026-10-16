/**
 * Read-only developer check for tracker ID 174 round 2: the "Stock to upload"
 * readers across invoice sources.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id174-invoice-sources.ts
 *
 * Through the real builders (stockUploadTasks/service.ts):
 *   - buyerAccountsFor('drive' | 'zoho') on the latest invoices of each source
 *     (Invoice Ledger hand link, then Bill To GSTIN) — how many resolve;
 *   - reversedTasks() on those invoices as if each had a task — which would
 *     close as voided / credit-noted;
 *   - the open tasks and the ones whose buyer is not linked.
 * Writes nothing (SELECTs only).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    buyerAccountsFor,
    hasStockTaskTables,
    listStockTasks,
    reversedTasks,
    type TaskInvoiceSource,
} from "@/lib/inventory/stockUploadTasks/service";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}`);
    console.log(`E-348 tables present: ${await hasStockTaskTables()}\n`);

    const latest: Record<TaskInvoiceSource, Array<{ id: string; invoice_number: string | null }>> = {
        drive: rowsOf(await db.execute(sql`
            SELECT id::text AS id, invoice_number FROM sales_invoices ORDER BY invoice_date DESC NULLS LAST LIMIT 25`)),
        zoho: rowsOf(await db.execute(sql`
            SELECT id::text AS id, invoice_number FROM zoho_invoices ORDER BY invoice_date DESC NULLS LAST LIMIT 25`)),
    };

    let fakeId = 1;
    for (const source of ["drive", "zoho"] as const) {
        const list = latest[source];
        const buyers = await buyerAccountsFor(source, list.map((r) => r.id));
        const linked = [...buyers.values()].filter(Boolean).length;
        console.log(`${source}: ${list.length} latest invoices, ${buyers.size} found, ${linked} with a buyer dealer account`);
        const gone = await reversedTasks(
            list.map((r) => ({ id: fakeId++, invoiceSource: source, invoiceId: r.id, invoiceNumber: r.invoice_number })),
        );
        console.log(`${source}: ${gone.size} would close as voided / credit-noted`);
        for (const [, note] of gone) console.log(`   ${note}`);
    }

    const open = await listStockTasks("open");
    if (open) {
        console.log(`\nopen tasks: ${open.length}; buyer not linked: ${open.filter((t) => !t.accountId).length}`);
        for (const t of open.slice(0, 20)) {
            console.log(`  #${t.id} [${t.invoiceSource}] ${t.invoiceNumber ?? "—"} · ${t.progress}`);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
