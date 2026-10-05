// Read-only check of the ID 62 GSTIN rule against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-id62-gstin.ts
//
// 1. The SQL match guard (gstinKeyIsMatchable) must agree with the TypeScript
//    rule (checkCustomerGstin) on every GSTIN stored anywhere, plus a fixed set.
// 2. Reports the stored GSTINs that fail the rule, per source — nothing is
//    changed; they simply no longer match an invoice to a dealer.
// 3. Reports the invoice-to-dealer links the guard removes.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkCustomerGstin } from "@/lib/leads/gstin";
import { GSTIN_KEY, gstinKeyIsMatchable } from "@/lib/leads/gstinMatch";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

type Row = { src: string; k: string; matchable: boolean };

const SOURCES: Array<{ src: string; from: SQL; expr: SQL }> = [
    { src: "dealer_leads.gstin", from: sql`dealer_leads`, expr: sql`gstin` },
    { src: "dealer_onboarding_applications.gst_number", from: sql`dealer_onboarding_applications`, expr: sql`gst_number` },
    { src: "accounts.gstin", from: sql`accounts`, expr: sql`gstin` },
    { src: "sales_invoices.customer_gstin", from: sql`sales_invoices`, expr: sql`customer_gstin` },
    { src: "zoho_invoices.gst_no", from: sql`zoho_invoices`, expr: sql`raw_json->>'gst_no'` },
];

const FIXED = [
    "06AALFI7813E1ZE", // iTarang — valid, but never a customer
    "07AALFI7813E1ZC", // iTarang
    "09GVUPP6577G1ZF", // valid
    "27AABCB1518L1ZS", // valid
    "09GVUPP6577G1ZE", // wrong check character
    "09GVUPP6578G1ZF", // one digit mistyped
    "07AAACB1234C1Z5", // right shape, wrong check character
    "07AAACB1234C1XH", // no Z
    "AAACB1234C", // a PAN
    "PENDING",
];

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);

    const fixed = (await db.execute<Row>(sql`
        SELECT 'fixed' AS src, t.k, ${gstinKeyIsMatchable(sql`t.k`)} AS matchable
          FROM (SELECT unnest(ARRAY[${sql.join(FIXED.map((g) => sql`${g}`), sql`, `)}]::text[]) AS k) t
    `)) as unknown as Row[];
    const fixedWrong = fixed.filter((r) => r.matchable !== (checkCustomerGstin(r.k) === "ok"));
    check("SQL guard agrees with checkCustomerGstin on the fixed set", fixed.length === FIXED.length && fixedWrong.length === 0, fixedWrong);
    check(
        "fixed set: exactly the two valid customer GSTINs are matchable",
        fixed.filter((r) => r.matchable).map((r) => r.k).sort().join() === "09GVUPP6577G1ZF,27AABCB1518L1ZS",
    );

    for (const s of SOURCES) {
        let rows: Row[];
        try {
            rows = (await db.execute<Row>(sql`
                SELECT ${s.src} AS src, t.k, ${gstinKeyIsMatchable(sql`t.k`)} AS matchable
                  FROM (SELECT DISTINCT ${GSTIN_KEY(s.expr)} AS k FROM ${s.from}) t
                 WHERE t.k IS NOT NULL
            `)) as unknown as Row[];
        } catch (e) {
            console.log(`SKIP  ${s.src} — ${(e as Error).message.split("\n")[0]}`);
            continue;
        }
        const wrong = rows.filter((r) => r.matchable !== (checkCustomerGstin(r.k) === "ok"));
        check(`${s.src}: SQL agrees with TypeScript on ${rows.length} distinct value(s)`, wrong.length === 0, wrong.slice(0, 5));
        const bad = rows.filter((r) => !r.matchable);
        const byReason: Record<string, number> = {};
        for (const r of bad) byReason[checkCustomerGstin(r.k)] = (byReason[checkCustomerGstin(r.k)] ?? 0) + 1;
        console.log(`      ${bad.length} stored value(s) fail the rule`, byReason, bad.slice(0, 8).map((r) => r.k));
    }

    // Links the guard removes: an invoice key equal to a lead / application
    // GSTIN that is not matchable.
    for (const inv of SOURCES.slice(3)) {
        try {
            const lost = (await db.execute<{ k: string; invoices: number }>(sql`
                SELECT i.k, COUNT(*)::int AS invoices
                  FROM (SELECT ${GSTIN_KEY(inv.expr)} AS k FROM ${inv.from}) i
                 WHERE i.k IS NOT NULL
                   AND NOT ${gstinKeyIsMatchable(sql`i.k`)}
                   AND EXISTS (
                        SELECT 1 FROM dealer_leads dl
                          LEFT JOIN dealer_onboarding_applications app ON app.id = dl.dealer_onboarding_application_id
                         WHERE ${GSTIN_KEY(sql`dl.gstin`)} = i.k OR ${GSTIN_KEY(sql`app.gst_number`)} = i.k)
                 GROUP BY i.k
            `)) as unknown as Array<{ k: string; invoices: number }>;
            console.log(`INFO  ${inv.src}: ${lost.length} failing GSTIN(s) no longer link to a dealer`, lost.slice(0, 10));
        } catch (e) {
            console.log(`SKIP  ${inv.src} — ${(e as Error).message.split("\n")[0]}`);
        }
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
