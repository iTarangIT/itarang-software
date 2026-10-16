// A14 — read-only: why does a rep show revenue but "Batteries sold 0"?
//
//   node --import tsx --env-file=.env.local      scripts/verify-a14-batteries.ts [name] [YYYY-MM]
//   node --import tsx --env-file=.env.production scripts/verify-a14-batteries.ts Jiten 2026-10
//
// For the rep (default "Jiten") and month (default this month) it lists every
// invoice credited to them (the revenue rule: matched to an account or lead,
// not void, owner on the invoice date) with its item lines, each line's class,
// HSN and mapping — then the batteries the dashboard counts, and why any
// invoice adds none. Writes nothing.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedLinesUnion, matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";

let failed = 0;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const name = process.argv[2] ?? "Jiten";
    const ist = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const month = process.argv[3] ?? ist.slice(0, 7);
    const from = `${month}-01`;
    const to = month === ist.slice(0, 7) ? ist : new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ·  ${name}  ·  ${from} → ${to}\n`);

    const users = rowsOf<{ id: string; name: string; role: string }>(
        await db.execute(sql`SELECT id::text AS id, name, role FROM users WHERE name ILIKE ${`%${name}%`} ORDER BY name`),
    );
    if (!users.length) {
        console.log("no such user");
        process.exit(1);
    }
    const src = await matchedUnion();
    const lines = await matchedLinesUnion();
    for (const u of users) {
        console.log(`== ${u.name} (${u.role}) ${u.id}`);
        const inv = rowsOf<{ id: string; source: string; invoice_number: string | null; invoice_date: string; total: number; customer: string | null }>(
            await db.execute(sql`
                SELECT r.id::text AS id, r.source, r.invoice_number, r.invoice_date::text AS invoice_date, r.total::float AS total,
                       r.customer_name AS customer
                  FROM ${src} AS r
                 WHERE ${REVENUE_NOT_VOID}
                   AND (r.account_id IS NOT NULL OR r.dealer_lead_id IS NOT NULL)
                   AND r.invoice_date BETWEEN ${from}::date AND ${to}::date
                   AND r.dealer_owner_id = ${u.id}
                 ORDER BY r.invoice_date`),
        );
        let revenue = 0;
        let batteries = 0;
        for (const i of inv) {
            revenue += Number(i.total);
            const ls = rowsOf<{ item_name: string | null; hsn: string | null; product_class: string | null; asset_type: string | null; quantity: number; mapped: string | null }>(
                await db.execute(sql`
                    SELECT l.item_name, l.hsn, l.product_class, l.asset_type, l.quantity::float AS quantity,
                           (SELECT m.asset_type FROM vyapar_item_map m WHERE m.item_name = l.item_name LIMIT 1) AS mapped
                      FROM invoice_line_items l
                     WHERE l.invoice_id = ${i.id}
                       AND (l.source = ${i.source} OR (${i.source} = 'drive' AND l.source IN ('vyapar', 'drive')))`),
            );
            const b = ls.filter((l) => l.product_class === "battery").reduce((a, l) => a + Number(l.quantity), 0);
            batteries += b;
            const why = !ls.length ? "NO ITEM LINES READ" : b === 0 ? "lines read, none classed battery" : `${b} battery unit(s)`;
            console.log(`  ${i.invoice_date} ${i.source.padEnd(6)} ${String(i.invoice_number ?? "").padEnd(14)} ₹${Math.round(i.total).toLocaleString("en-IN").padStart(10)}  ${(i.customer ?? "").slice(0, 28).padEnd(28)}  → ${why}`);
            for (const l of ls) {
                console.log(`      · ${(l.item_name ?? "?").slice(0, 40).padEnd(40)} hsn ${String(l.hsn ?? "—").padEnd(8)} class ${String(l.product_class ?? "—").padEnd(14)} qty ${l.quantity}  mapped-as ${l.mapped ?? "—"}`);
            }
        }
        console.log(`  revenue ₹${Math.round(revenue).toLocaleString("en-IN")} · batteries by these lines ${batteries}`);
        if (lines) {
            const dash = await buildSalesDashboard({ from, to, granularity: "month" } as never);
            const me = (dash.per_spoc ?? []).find((s) => s.spoc_id === u.id);
            const dashBat = Number(me?.outcome.batteries_to_dealers ?? 0);
            const dashRev = Math.round(Number(me?.outcome.revenue ?? 0));
            console.log(`  dashboard: revenue ₹${dashRev.toLocaleString("en-IN")} · batteries ${dashBat}`);
            const ok = dashBat === batteries && dashRev === Math.round(revenue);
            if (!ok) failed++;
            console.log(`${ok ? "PASS" : "FAIL"}  dashboard batteries and revenue = the invoice lines above\n`);
        }
    }
    console.log(failed === 0 ? "All checks passed." : `${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
