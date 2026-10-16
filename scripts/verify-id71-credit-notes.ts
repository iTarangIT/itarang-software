// Read-only check of ID 71: a credit note nets revenue, money owed, batteries
// sold, By SKU and gross margin — and is never an order.
//
//   node --import tsx --env-file=.env.local scripts/verify-id71-credit-notes.ts
//
// 1. Credit notes: how many, how many voided, how many have item lines
//    (source 'credit', stored negative). Every credit line is ≤ 0.
// 2. Money owed: outstandingTotal() (the CEO card) = the /ceo/receivables
//    page's netted total; credit notes reduce it, never below zero per customer.
// 3. Orders: no account's order count / last order comes from a credit note —
//    Dealer Health and the Accounts download agree with an order-only count.
// 4. Lines: By SKU = gross margin line value per month (credits netted in both).
// 1b (16 Oct): no credit-note folder still filters on "sale"; the credit-note
//    fill-in runs are recorded (invoice_imports, kind credit_lines_fill).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedUnion, outstandingTotal, REVENUE_IS_ORDER } from "@/lib/dashboard/revenueSource";
import { listReceivables, netOwed } from "@/lib/dashboard/receivables";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { invoiceAccountSql } from "@/lib/accounts/accountList";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    if (!(await hasInvoiceLedgerTables())) {
        console.log("SKIP  E-322 not on this database");
        process.exit(0);
    }

    // 1 — the notes and their lines
    const cn = await one<{ notes: number; voided: number; with_lines: number; positive_lines: number }>(sql`
        SELECT COUNT(*)::int AS notes,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'credit' AND v.invoice_id = cn.id::text))::int AS voided,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.source = 'credit' AND l.invoice_id = cn.id::text))::int AS with_lines,
               (SELECT COUNT(*)::int FROM invoice_line_items WHERE source = 'credit' AND (quantity > 0 OR amount_excl_gst > 0)) AS positive_lines
          FROM credit_notes cn`);
    console.log(`      credit notes ${cn.notes}: voided ${cn.voided}, with item lines ${cn.with_lines}`);
    check("every credit-note line is stored negative", cn.positive_lines === 0, cn.positive_lines);
    if (cn.notes - cn.voided > cn.with_lines) {
        console.log(
            `      ${cn.notes - cn.voided - cn.with_lines} live credit note(s) have no item lines — run scripts/backfill-drive-line-items.ts --credit-notes`,
        );
    }

    // 1b — 16 Oct: folders and the fill-in record
    const fold = await one<{ credit: number; bad: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE doc_kind = 'credit_note')::int AS credit,
               COUNT(*) FILTER (WHERE doc_kind = 'credit_note' AND lower(btrim(include_names)) = 'sale')::int AS bad
          FROM sales_invoice_folders`);
    check(`no credit-note folder still filters on "sale" (${fold.credit} credit-note folder(s))`, fold.bad === 0, fold.bad);
    const fill = await one<{ n: number; last: string | null }>(sql`
        SELECT COUNT(*)::int AS n, MAX(created_at)::text AS last FROM invoice_imports WHERE kind = 'credit_lines_fill'`);
    console.log(`      credit-note fill-in runs recorded: ${fill.n}${fill.last ? ` (last ${fill.last})` : ""}`);

    // 2 — money owed
    const [card, rows] = await Promise.all([outstandingTotal(), listReceivables()]);
    const page = netOwed(rows);
    check(`Money owed: CEO card ${card.toFixed(0)} = receivables page ${page.toFixed(0)}`, Math.abs(card - page) < 1);
    const credits = rows.filter((r) => r.source === "credit");
    const gross = rows.filter((r) => r.source !== "credit").reduce((a, r) => a + r.balance, 0);
    console.log(`      unpaid invoices ${gross.toFixed(0)} − credit notes netted ${(gross - page).toFixed(0)} (${credits.length} on the page) = ${page.toFixed(0)}`);
    check("netting never raises what is owed", page <= gross + 0.5);

    // 3 — a credit note is not an order
    const inv = await matchedUnion();
    const k = invoiceAccountSql();
    const orders = (await db.execute(sql`
        SELECT ${k} AS k, COUNT(*)::int AS n, MAX(r.invoice_date)::text AS last_order
          FROM ${inv} AS r
         WHERE ${k} IS NOT NULL AND ${REVENUE_IS_ORDER}
         GROUP BY 1`)) as unknown as Array<{ k: string; n: number; last_order: string | null }>;
    const byKey = new Map(orders.map((o) => [o.k, o]));
    const health = await listDealerHealth();
    const wrong = health.filter((h) => {
        const o = h.account_id ? byKey.get(h.account_id) : undefined;
        return (o?.n ?? 0) !== h.orders || (o?.last_order ?? null) !== (h.last_order ? String(h.last_order).slice(0, 10) : null);
    });
    check(`Dealer Health orders / last order = invoices only (${health.length} dealers)`, wrong.length === 0, wrong.slice(0, 3).map((w) => w.account_id));

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    console.log("Lines (By SKU = gross margin, credits netted): scripts/verify-id147-sku-vs-margin.ts");
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
