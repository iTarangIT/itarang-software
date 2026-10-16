// ID 71 business check, end to end — SANDBOX ONLY (writes, then removes).
//
//   node --import tsx --env-file=.env.local scripts/verify-id71-credit-note-e2e.ts [YYYY-MM]
//
// "Enter a credit note for 2 batteries: the month's batteries sold, By SKU and
// gross margin all drop by them." Picks a dealer-matched invoice with battery
// lines in the month, inserts a credit note for 2 of its batteries (same
// customer GSTIN, dated in the month, lines stored negative as the scan does),
// re-reads the Sales dashboard, By SKU and gross margin, checks each dropped
// by exactly 2 batteries, then deletes the note and its lines and checks
// everything is back. Refuses to run against database-2 (prod).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { skuReport } from "@/lib/sales/skuReport";
import { matchedLinesUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function measure(from: string, to: string) {
    const [dash, sku] = await Promise.all([buildSalesDashboard({ from, to, granularity: "month" }), skuReport(from, to)]);
    const lines = await matchedLinesUnion();
    const [gm] = rowsOf<{ units: number; value: number }>(
        await db.execute(sql`
            SELECT COALESCE(SUM(r.quantity), 0)::float AS units, COALESCE(SUM(r.amount_excl_gst), 0)::float AS value
              FROM ${lines!} AS r
             WHERE r.product_class = 'battery' AND ${REVENUE_NOT_VOID}
               AND r.invoice_date BETWEEN ${from}::date AND ${to}::date`),
    );
    return {
        dashboard: Number(dash.outcome.batteries_to_dealers),
        revenue: Number(dash.outcome.revenue),
        sku: sku.rows.filter((r) => r.product_class === "battery").reduce((a, r) => a + r.quantity, 0),
        lineUnits: Number(gm.units),
        lineValue: Number(gm.value),
    };
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    console.log(`DB host: ${host}\n`);
    if (host.startsWith("database-2.")) throw new Error("refusing to write on prod (database-2)");

    const month = process.argv[2] ?? "2026-09";
    const from = `${month}-01`;
    const to = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);

    const lines = await matchedLinesUnion();
    if (!lines) throw new Error("E-322 not on this database");
    const [pick] = rowsOf<{ id: string; source: string; gstin: string | null; customer: string; rate: number; item: string; hsn: string; org: string | null }>(
        await db.execute(sql`
            SELECT r.id, r.source, si.customer_gstin AS gstin, r.customer_name AS customer, r.item_name AS item, r.hsn,
                   (r.amount_excl_gst / NULLIF(r.quantity, 0))::float AS rate, r.organization_id AS org
              FROM ${lines} AS r
              JOIN sales_invoices si ON si.id::text = r.id
             WHERE r.product_class = 'battery' AND r.quantity >= 2 AND r.dealer_owner_id IS NOT NULL
               AND si.customer_gstin IS NOT NULL
               AND r.invoice_date BETWEEN ${from}::date AND ${to}::date
             ORDER BY r.invoice_date DESC LIMIT 1`),
    );
    if (!pick) throw new Error(`no dealer-credited battery invoice in ${month}`);
    console.log(`      against ${pick.customer} (${pick.gstin}) — ${pick.item}, ₹${Math.round(pick.rate)} / unit`);

    const before = await measure(from, to);
    console.log("      before", before);
    const noteNo = `E2E-CN-${Date.now()}`;
    const amount = Math.round(pick.rate * 2 * 100) / 100;
    let noteId: string | null = null;
    try {
        const [cn] = rowsOf<{ id: string }>(
            await db.execute(sql`
                INSERT INTO credit_notes (note_number, note_number_key, issue_date, customer_name, customer_gstin, organization_id,
                                          sub_total, tax_total, total, file_name)
                VALUES (${noteNo}, ${noteNo.toLowerCase()}, ${to}::date, ${pick.customer}, ${pick.gstin}, ${pick.org},
                        ${amount}, ${Math.round(amount * 0.05 * 100) / 100}, ${Math.round(amount * 1.05 * 100) / 100}, 'verify-id71-e2e')
                RETURNING id::text AS id`),
        );
        noteId = cn.id;
        await db.execute(sql`
            INSERT INTO invoice_line_items (source, invoice_id, line_no, item_name, hsn, product_class, quantity, rate, amount_excl_gst)
            VALUES ('credit', ${noteId}, 1, ${pick.item}, ${pick.hsn}, 'battery', -2, ${pick.rate}, ${-amount})`);

        const after = await measure(from, to);
        console.log("      after ", after);
        check(`Sales dashboard batteries sold dropped by 2 (${before.dashboard} → ${after.dashboard})`, after.dashboard === before.dashboard - 2);
        check(`By SKU batteries dropped by 2 (${before.sku} → ${after.sku})`, after.sku === before.sku - 2);
        check(
            `gross margin battery lines dropped by 2 units and ₹${amount} (${before.lineValue} → ${after.lineValue})`,
            after.lineUnits === before.lineUnits - 2 && Math.abs(after.lineValue - (before.lineValue - amount)) < 1,
        );
        check(`revenue dropped by the note's total (${before.revenue} → ${after.revenue})`, after.revenue < before.revenue);
    } finally {
        if (noteId) {
            await db.execute(sql`DELETE FROM invoice_line_items WHERE source = 'credit' AND invoice_id = ${noteId}`);
            await db.execute(sql`DELETE FROM credit_notes WHERE id = ${noteId}::uuid`);
        }
    }
    const restored = await measure(from, to);
    check("removed again: every figure is back", JSON.stringify(restored) === JSON.stringify(before), restored);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
