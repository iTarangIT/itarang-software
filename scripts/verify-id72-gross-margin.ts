// Check the ID 72 gross-margin query against the live DB without leaving
// anything behind: synthetic invoices dated January 2099 are inserted inside a
// transaction, the REAL query (grossMarginByMonth) is run on that transaction,
// and the transaction is rolled back.
//
//   node --import tsx --env-file=.env.local scripts/verify-id72-gross-margin.ts
//
// Requires E-326. Uses one real product that has costed stock for the cost side.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { grossMarginByMonth, grossMarginTablesPresent } from "@/lib/dashboard/grossMargin";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

class Rollback extends Error {}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    if (!(await grossMarginTablesPresent())) {
        console.log("E-326 is not applied on this database.");
        process.exit(1);
    }

    const [stock] = (await db.execute<{ product_id: string; avg_cost: string }>(sql`
        SELECT product_id, AVG(inventory_amount) AS avg_cost
          FROM inventory WHERE product_id IS NOT NULL AND inventory_amount > 0
         GROUP BY product_id ORDER BY COUNT(*) DESC LIMIT 1
    `)) as unknown as { product_id: string; avg_cost: string }[];
    if (!stock) {
        console.log("No costed stock on this database — nothing to verify against.");
        process.exit(1);
    }
    const avgCost = Number(stock.avg_cost);
    console.log(`cost product ${stock.product_id}, average OEM cost ${avgCost.toFixed(2)}`);

    // A product with a price-book line but no stock, when one exists.
    const [book] = (await db.execute<{ product_id: string; oem_price: string }>(sql`
        SELECT r.product_id, r.oem_price FROM oem_reference_prices r
          JOIN products p ON p.id::text = r.product_id
         WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = p.id AND i.inventory_amount > 0)
         ORDER BY r.effective_from DESC LIMIT 1
    `)) as unknown as { product_id: string; oem_price: string }[];

    try {
        await db.transaction(async (tx) => {
            const invoice = async (key: string, subTotal: number, status = "sent") => {
                const [row] = (await tx.execute<{ id: string }>(sql`
                    INSERT INTO sales_invoices (source, invoice_number, invoice_number_key, invoice_date, sub_total, total, status)
                    VALUES ('drive', ${key}, ${key}, DATE '2099-01-15', ${subTotal}, ${subTotal * 1.18}, ${status})
                    RETURNING id
                `)) as unknown as { id: string }[];
                return row.id;
            };
            const line = (invoiceId: string, n: number, name: string, hsn: string | null, qty: number, amount: number) =>
                tx.execute(sql`
                    INSERT INTO sales_invoice_lines (sales_invoice_id, line_no, description, item_key, hsn_code, quantity, rate, amount)
                    VALUES (${invoiceId}::uuid, ${n}, ${name}, ${name}, ${hsn}, ${qty}, ${amount / qty}, ${amount})
                `);
            const map = (name: string, productId: string | null) =>
                tx.execute(sql`
                    INSERT INTO sales_invoice_item_products (item_key, item_name, product_id)
                    VALUES (${name}, ${name}, ${productId}::uuid)
                `);

            await map("verify72 battery", stock.product_id);
            await map("verify72 unmapped charger", null);
            if (book) await map("verify72 price book item", book.product_id);

            // A: 2 batteries (costed from stock) + 1 charger with no product. Adds up.
            const a = await invoice("VERIFY72-A", 200000 + 9000);
            await line(a, 1, "verify72 battery", "85076000", 2, 200000);
            await line(a, 2, "verify72 unmapped charger", "85044030", 1, 9000);
            // B: lines do not add up to the taxable value — ignored.
            const b = await invoice("VERIFY72-B", 50000);
            await line(b, 1, "verify72 battery", "85076000", 1, 30000);
            // C: void — out entirely.
            const c = await invoice("VERIFY72-C", 70000, "void");
            await line(c, 1, "verify72 battery", "85076000", 1, 70000);
            // D: no lines at all.
            await invoice("VERIFY72-D", 10000);
            // E: costed from the price book.
            if (book) {
                const e = await invoice("VERIFY72-E", 40000);
                await line(e, 1, "verify72 price book item", null, 1, 40000);
            }

            const report = await grossMarginByMonth({ from: "2099-01-01", to: "2099-01-31", runner: tx });
            const m = report.months[0];
            console.log(JSON.stringify(m, null, 1));

            const bookRevenue = book ? 40000 : 0;
            const bookCost = book ? Number(book.oem_price) : 0;
            check("one month, January 2099", report.months.length === 1 && m?.month === "2099-01");
            check("void invoice is excluded", m.invoices === (book ? 4 : 3));
            check("invoiced before GST", near(m.invoice_revenue, 209000 + 50000 + 10000 + bookRevenue));
            check("invoices without usable lines: B (does not add up) and D (none)", m.invoices_without_lines === 2 && near(m.revenue_without_lines, 60000));
            check("battery revenue and quantity", near(m.by_type.battery.revenue, 200000) && near(m.by_type.battery.quantity, 2));
            check("battery cost = quantity × average OEM cost", near(m.by_type.battery.cost, 2 * avgCost), m.by_type.battery.cost);
            check("battery margin and %", near(m.by_type.battery.margin, 200000 - 2 * avgCost) && near(m.by_type.battery.margin_pct ?? -1, (200000 - 2 * avgCost) / 200000));
            check("unmapped charger is not costed, never margin", near(m.by_type.charger.not_costed, 9000) && m.by_type.charger.revenue === 0 && m.by_type.charger.margin_pct === null);
            check("total = costed lines only", near(m.total.revenue, 200000 + bookRevenue) && near(m.total.cost, 2 * avgCost + bookCost) && near(m.total.not_costed, 9000));
            check("stock cost source is 'all_invoices' (no OEM invoice near 2099)", near(report.cost_sources.all_invoices, 200000) && report.cost_sources.recent_invoices === 0);
            if (book) check("price-book fallback used for a product with no stock", near(report.cost_sources.price_book, 40000));
            else console.log("SKIP  no price-book-only product on this database");

            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }

    const left = (await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM sales_invoices WHERE invoice_number_key LIKE 'VERIFY72-%'
    `)) as unknown as { n: number }[];
    check("rolled back — nothing left behind", left[0].n === 0);

    const real = await grossMarginByMonth();
    console.log(`\nReal data: ${real.months.length} month(s);`, real.months.map((x) => `${x.month}: ${x.invoices_without_lines}/${x.invoices} invoices without lines`).join("; "));

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
