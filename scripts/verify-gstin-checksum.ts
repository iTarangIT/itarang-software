// Read-only check for tracker ID 62 (GSTIN check digit).
//
// Lists the GSTINs ALREADY stored — on leads, onboardings, accounts and sales
// invoices — that the new shared check (src/lib/leads/gstin.ts) would refuse:
// wrong shape, wrong check digit, or one of iTarang's own. Nothing is changed;
// this is the list someone corrects by hand.
//
//   node --import tsx --env-file=.env.local scripts/verify-gstin-checksum.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkCustomerGstin, normalizeGstin } from "@/lib/leads/gstin";

type Row = { id: string; label: string | null; gstin: string };

async function report(title: string, rows: Row[]) {
    const bad = rows
        .map((r) => ({ ...r, check: checkCustomerGstin(r.gstin) }))
        .filter((r) => r.check !== "ok");
    console.log(`\n${title}: ${rows.length} with a GSTIN, ${bad.length} fail`);
    for (const r of bad.slice(0, 50)) {
        console.log(`  ${r.check.padEnd(15)} ${normalizeGstin(r.gstin).padEnd(16)} ${r.id}  ${r.label ?? ""}`);
    }
    if (bad.length > 50) console.log(`  … and ${bad.length - 50} more`);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    await report(
        "dealer_leads.gstin",
        (await db.execute<Row>(sql`
            SELECT id, dealer_name AS label, gstin FROM dealer_leads
            WHERE NULLIF(BTRIM(gstin), '') IS NOT NULL
        `)) as unknown as Row[],
    );
    await report(
        "dealer_onboarding_applications.gst_number",
        (await db.execute<Row>(sql`
            SELECT id::text AS id, company_name AS label, gst_number AS gstin FROM dealer_onboarding_applications
            WHERE NULLIF(BTRIM(gst_number), '') IS NOT NULL
        `)) as unknown as Row[],
    );
    // "PENDING" is the placeholder the approve route writes when the GSTIN is missing.
    await report(
        "accounts.gstin (excluding PENDING)",
        (await db.execute<Row>(sql`
            SELECT id, business_entity_name AS label, gstin FROM accounts
            WHERE NULLIF(BTRIM(gstin), '') IS NOT NULL AND UPPER(BTRIM(gstin)) <> 'PENDING'
        `)) as unknown as Row[],
    );
    try {
        await report(
            "sales_invoices.customer_gstin",
            (await db.execute<Row>(sql`
                SELECT id::text AS id, COALESCE(invoice_number, '') || ' ' || COALESCE(customer_name, '') AS label,
                       customer_gstin AS gstin
                FROM sales_invoices
                WHERE NULLIF(BTRIM(customer_gstin), '') IS NOT NULL
            `)) as unknown as Row[],
        );
    } catch (e) {
        console.log(`\nsales_invoices: skipped (${(e as Error).message.split("\n")[0]})`);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
