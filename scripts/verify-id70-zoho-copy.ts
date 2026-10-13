// Read-only check of ID 70: the one-time Zoho copy (customer GSTINs + invoice
// lines) is complete and its lines are linked to products like every other line.
//
//   node --import tsx --env-file=.env.local scripts/verify-id70-zoho-copy.ts
//
// 1. Every Zoho invoice has been read (lines present, or an E-340 read marker).
// 2. No line of an ALREADY MAPPED item is left unlinked (ID 147 stamps at insert;
//    scripts/relink-unmapped-lines.ts fixes older ones).
// 3. Customers: how many have a GSTIN, none, a refused one, or are still unfetched.
// 4. How many Zoho invoices now match a dealer account, and how many accounts
//    that read "Never ordered" from Drive invoices alone now have a Zoho order.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { itemKeySql } from "@/lib/sales/itemMap";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const t = await one<{ e322: boolean; e340: boolean; refused_col: boolean }>(sql`
        SELECT to_regclass('public.zoho_customer_gstins') IS NOT NULL AS e322,
               to_regclass('public.zoho_invoice_line_fetches') IS NOT NULL AS e340,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'zoho_customer_gstins' AND column_name = 'refused_gstin') AS refused_col`);
    if (!t.e322) {
        console.log("SKIP  E-322 not on this database");
        process.exit(0);
    }
    check("E-340 applied (read markers + refused GSTINs)", t.e340 && t.refused_col);

    // 1 — every invoice read
    const marker = t.e340 ? sql`OR EXISTS (SELECT 1 FROM zoho_invoice_line_fetches f WHERE f.invoice_id = zi.id::text)` : sql``;
    const inv = await one<{ total: number; read: number; lines: number }>(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoice_line_items l
                                                WHERE l.source = 'zoho' AND l.invoice_id = zi.id::text) ${marker})::int AS read,
               (SELECT COUNT(*)::int FROM invoice_line_items WHERE source = 'zoho') AS lines
          FROM zoho_invoices zi`);
    check(`Zoho invoices read: ${inv.read}/${inv.total} (${inv.lines} lines)`, inv.read === inv.total, inv.total - inv.read);

    // 2 — mapped items linked
    const unlinked = await one<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
          FROM invoice_line_items l
          JOIN vyapar_item_map m ON m.item_key = ${itemKeySql(sql`l.item_name`)} AND m.product_id IS NOT NULL
         WHERE l.source = 'zoho' AND l.product_id IS NULL`);
    check("no Zoho line of a mapped item is left unlinked", unlinked.n === 0, unlinked.n);
    const unmappedNames = await one<{ n: number }>(sql`
        SELECT COUNT(DISTINCT ${itemKeySql(sql`l.item_name`)})::int AS n
          FROM invoice_line_items l
         WHERE l.source = 'zoho' AND btrim(COALESCE(l.item_name, '')) <> ''
           AND NOT EXISTS (SELECT 1 FROM vyapar_item_map m WHERE m.item_key = ${itemKeySql(sql`l.item_name`)})`);
    check("every Zoho item name is listed in Item mapping", unmappedNames.n === 0, unmappedNames.n);

    // 3 — customers
    const refused = t.refused_col ? sql`COUNT(*) FILTER (WHERE g.refused_gstin IS NOT NULL)::int` : sql`0`;
    const cust = await one<{ customers: number; with_gstin: number; without: number; refused: number; unfetched: number }>(sql`
        WITH c AS (SELECT DISTINCT organization_id, customer_id FROM zoho_invoices WHERE customer_id IS NOT NULL)
        SELECT COUNT(*)::int AS customers,
               COUNT(*) FILTER (WHERE g.gstin IS NOT NULL)::int AS with_gstin,
               COUNT(*) FILTER (WHERE g.customer_id IS NOT NULL AND g.gstin IS NULL)::int AS without,
               ${refused} AS refused,
               COUNT(*) FILTER (WHERE g.customer_id IS NULL)::int AS unfetched
          FROM c LEFT JOIN zoho_customer_gstins g
            ON g.organization_id = COALESCE(c.organization_id, '') AND g.customer_id = c.customer_id`);
    console.log(
        `      customers ${cust.customers}: GSTIN ${cust.with_gstin} · none ${cust.without} (refused by the check ${cust.refused}) · not fetched yet ${cust.unfetched}`,
    );
    // A customer left unfetched after all their invoices were read carried no
    // GSTIN on any invoice; only Zoho's contacts endpoint could add one, and
    // the CRM's token lacks that scope — reported, not a failure of the copy.
    if (cust.unfetched > 0) {
        console.log(`      ${cust.unfetched} customer(s) had no GSTIN on any invoice — needs the Zoho contacts scope, or link by hand`);
    }
    check("every Zoho customer with an unread invoice is done", inv.read === inv.total || cust.unfetched === 0);

    // 4 — what it changed for dealers
    const union = await matchedUnion();
    const m = await one<{ zoho: number; zoho_matched: number; accounts_zoho_only: number }>(sql`
        WITH r AS (SELECT * FROM ${union} AS u)
        SELECT COUNT(*) FILTER (WHERE r.source = 'zoho')::int AS zoho,
               COUNT(*) FILTER (WHERE r.source = 'zoho' AND r.account_id IS NOT NULL)::int AS zoho_matched,
               (SELECT COUNT(DISTINCT x.account_id)::int FROM r x
                 WHERE x.source = 'zoho' AND x.account_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM r y WHERE y.account_id = x.account_id AND y.source = 'drive')) AS accounts_zoho_only
          FROM r WHERE ${REVENUE_NOT_VOID}`);
    console.log(
        `      Zoho invoices matched to a dealer account: ${m.zoho_matched}/${m.zoho}; accounts whose only orders are Zoho-era (were "Never ordered" before the copy): ${m.accounts_zoho_only}`,
    );

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
