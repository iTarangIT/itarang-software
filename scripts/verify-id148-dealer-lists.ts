// Read-only check of ID 148: Accounts, Dealer Health and the Dealer accounts
// download count ONE dealer list by ONE set of rules.
//
//   node --import tsx --env-file=.env.local scripts/verify-id148-dealer-lists.ts
//
// 1. The same accounts in all three (the Accounts screen's population is
//    accountList.dealerAccountSql, read here directly).
// 2. The same order count per account in Dealer Health and the download.
// 3. "GSTIN missing" is the same number on the screen's counts and the download.
// Also prints how many unowned accounts get a suggested owner.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { countAccounts, dealerAccountSql, gstinMissingSql, listAccounts } from "@/lib/accounts/accountList";
import { listDealerHealth } from "@/lib/dealers/accountHealth";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const [download, health, counts] = await Promise.all([listAccounts(), listDealerHealth(), countAccounts()]);
    const [screen] = (await db.execute(sql`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE ${gstinMissingSql(sql`a.gstin`)})::int AS gstin_missing
          FROM accounts a WHERE ${dealerAccountSql()}
    `)) as unknown as Array<{ n: number; gstin_missing: number }>;

    console.log(`Accounts screen ${screen.n} · Dealer Health ${health.length} · download ${download.length}`);
    check("Dealer Health lists the Accounts screen's dealers", health.length === screen.n);
    check("the download lists the Accounts screen's dealers", download.length === screen.n);
    const healthIds = new Set(health.map((h) => h.account_id));
    const missing = download.filter((d) => !healthIds.has(d.account_id)).map((d) => d.account_id);
    check("every downloaded account is in Dealer Health", missing.length === 0, missing.slice(0, 5));

    const orders = new Map(health.map((h) => [h.account_id, h.orders]));
    const differ = download.filter((d) => orders.get(d.account_id) !== d.orders);
    check("same order count per account (Health vs download)", differ.length === 0,
        differ.slice(0, 5).map((d) => ({ id: d.account_id, download: d.orders, health: orders.get(d.account_id) })));

    check("GSTIN missing: screen = counts = download",
        screen.gstin_missing === counts.gstin_missing && counts.gstin_missing === download.filter((d) => d.gstin_missing).length,
        { screen: screen.gstin_missing, counts: counts.gstin_missing, download: download.filter((d) => d.gstin_missing).length });

    const unowned = download.filter((d) => !d.owner_id);
    console.log(`\nunowned ${unowned.length}, with a suggested owner ${unowned.filter((d) => d.suggested_owner_id).length}`);
    console.log(`closed (E-332): ${health.filter((h) => h.bucket === "closed").length}`);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e?.cause ?? e);
    process.exit(1);
});
