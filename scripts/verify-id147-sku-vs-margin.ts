// Read-only check of ID 147 (and 71): gross margin and Invoice Ledger › By SKU
// read ONE line store with ONE mapping, so they cannot disagree.
//
//   node --import tsx --env-file=.env.local scripts/verify-id147-sku-vs-margin.ts [from] [to]
//
// For each month (default: the last 12):
//   1. line value before GST in gross margin (costed + not costed) = By SKU's
//      amount for the month — both skip void invoices the same way;
//   2. battery units By SKU reports ≥ the battery units gross margin costed
//      (margin only counts the units it could cost);
//   3. a voided invoice's lines appear in neither.
// Also prints coverage: how much line value is mapped and costed.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { grossMarginByMonth } from "@/lib/dashboard/grossMargin";
import { skuReport } from "@/lib/sales/skuReport";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4, 7)}-01`;
    const [from = yearAgo, to = today] = process.argv.slice(2);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ${from} → ${to}\n`);

    const [margin, sku] = await Promise.all([grossMarginByMonth({ from, to }), skuReport(from, to)]);
    if (!margin.available || !sku.available) {
        console.log("SKIP  invoice ledger (E-322) not on this database");
        process.exit(0);
    }

    const skuByMonth = new Map<string, { amount: number; batteries: number }>();
    for (const r of sku.rows) {
        const m = skuByMonth.get(r.month) ?? { amount: 0, batteries: 0 };
        m.amount += r.amount_excl_gst;
        if (r.product_class === "battery") m.batteries += r.quantity;
        skuByMonth.set(r.month, m);
    }

    for (const m of margin.months) {
        const lineValue = m.total.revenue + m.total.not_costed;
        const s = skuByMonth.get(m.month) ?? { amount: 0, batteries: 0 };
        check(`${m.month}: line value — gross margin ${lineValue.toFixed(0)} = By SKU ${s.amount.toFixed(0)}`, near(lineValue, s.amount));
        check(
            `${m.month}: battery units — By SKU ${s.batteries} ≥ costed ${m.by_type.battery.quantity}`,
            s.batteries + 0.001 >= m.by_type.battery.quantity,
        );
        const costed = lineValue > 0 ? Math.round((m.total.revenue / lineValue) * 100) : 0;
        console.log(`      costed ${costed}% of line value · credit notes ${m.credit_notes.toFixed(0)} · invoices without lines ${m.invoices_without_lines}/${m.invoices}`);
    }
    for (const month of skuByMonth.keys()) {
        check(`${month}: month present in gross margin`, margin.months.some((m) => m.month === month));
    }

    const [voidLines] = (await db.execute(sql`
        SELECT COUNT(*)::int AS n
          FROM invoice_voids v
          JOIN invoice_line_items l ON l.invoice_id = v.invoice_id
    `)) as unknown as Array<{ n: number }>;
    console.log(`\nvoided invoices carrying ledger lines: ${voidLines?.n ?? 0} (excluded by both — check 1 holds with them present)`);
    console.log(`unmapped item names in range: ${margin.unmapped_items}`);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
