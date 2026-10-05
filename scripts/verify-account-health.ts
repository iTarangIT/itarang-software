// Read-only check for tracker IDs 65 and 41 (dealer account model, E-322).
//
// Runs the REAL account list (src/lib/accounts/accountList.ts) — the one
// Account management, dealer health and the Dealer accounts download read — and
// prints what moved when dealer health went from Converted LEADS to ACCOUNTS.
//
//   node --import tsx --env-file=.env.local scripts/verify-account-health.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { countAccounts, listAccounts } from "@/lib/accounts/accountList";
import { ACCOUNT_BUCKETS } from "@/lib/dealers/accountHealthRules";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const cols = (await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'accounts'
           AND column_name IN ('account_owner_id', 'onboarded_by_user_id', 'came_through', 'activated_at')
    `)) as unknown as { column_name: string }[];
    if (cols.length < 4) {
        console.log(`E-322 is NOT applied here (found ${cols.length} of 4 columns). Apply drizzle/E-322_account_owner_model.sql first.`);
        process.exit(1);
    }

    const [counts, rows] = await Promise.all([countAccounts(), listAccounts()]);
    console.log(`dealer accounts: ${counts.total}  ·  no owner: ${counts.no_owner}  ·  GSTIN missing: ${counts.gstin_missing}`);

    const [old] = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads WHERE lead_status = 'Converted' AND is_active IS NOT FALSE
    `)) as unknown as { n: number }[];
    const direct = rows.filter((r) => r.came_through === "direct").length;
    const viaLead = rows.filter((r) => r.came_through === "lead").length;
    console.log(`before (Converted leads): ${old.n}  ·  now (accounts): ${rows.length} = ${viaLead} through a lead + ${direct} direct + ${rows.length - viaLead - direct} not recorded`);

    for (const b of ACCOUNT_BUCKETS) {
        console.log(`  ${b.padEnd(16)} ${rows.filter((r) => r.bucket === b).length}`);
    }
    const withOrders = rows.filter((r) => r.orders > 0);
    console.log(`accounts with at least one matched invoice: ${withOrders.length}`);
    const suggested = rows.filter((r) => !r.owner_id && r.suggested_owner_id).length;
    console.log(`no-owner accounts with a suggested owner: ${suggested} of ${counts.no_owner}`);
    for (const r of rows.slice(0, 5)) {
        console.log(
            `  - ${r.dealer} [${r.account_id}] owner=${r.owner_name ?? "—"} onboarded_by=${r.onboarded_by_name ?? "—"} ` +
                `came=${r.came_through ?? "—"} last=${r.last_order ?? "—"} bucket=${r.bucket}`,
        );
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
