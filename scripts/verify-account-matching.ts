/**
 * Read-only check of E-321 invoice matching (tracker IDs 5, 67, 68, 69).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-account-matching.ts
 *
 * Imports the real query builders (no restated SQL) and reports:
 *   1. invoices by match_status (credited / no_owner / unknown / not_dealer)
 *      and that every invoice got exactly one status;
 *   2. the unmatched total the daily email prints;
 *   3. dealer health population (accounts) and direct-onboarding count;
 *   4. timing of matchedUnion, since it now runs two laterals per invoice.
 * Writes nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedUnion, revenueSummary } from "@/lib/dashboard/revenueSource";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";

async function main() {
    const on = await hasAccountOwnershipTables();
    console.log(`E-321 tables present: ${on}`);

    const t0 = Date.now();
    const src = await matchedUnion();
    const rows = (await db.execute(sql`
        SELECT r.match_status, count(*)::int AS n, COALESCE(sum(r.total), 0)::numeric(14,2) AS total
          FROM ${src} AS r
         GROUP BY 1 ORDER BY 1
    `)) as unknown as Array<{ match_status: string | null; n: number; total: string }>;
    console.log(`\nmatchedUnion by status (${Date.now() - t0} ms):`);
    console.table(rows);
    const bad = rows.filter((r) => !["credited", "no_owner", "unknown", "not_dealer"].includes(String(r.match_status)));
    if (bad.length) throw new Error(`unexpected match_status values: ${JSON.stringify(bad)}`);

    const dupes = (await db.execute(sql`
        SELECT count(*)::int AS n FROM (
            SELECT r.source, r.id FROM ${src} AS r GROUP BY 1, 2 HAVING count(*) > 1) d
    `)) as unknown as Array<{ n: number }>;
    if (dupes[0]?.n) throw new Error(`${dupes[0].n} invoices appear more than once in matchedUnion`);
    console.log("✓ one row per invoice");

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const s = await revenueSummary({ from: monthStart, to: today });
    console.log(`\nMTD ${monthStart}..${today}: ${s.count} invoices, ₹${s.total.toFixed(2)}; not matched to a dealer: ${s.unlinked_count} / ₹${s.unlinked_total.toFixed(2)}`);

    const t1 = Date.now();
    const health = await listDealerHealth();
    const direct = health.filter((h) => h.came_through === "direct").length;
    const withOwner = health.filter((h) => h.owner_id).length;
    console.log(`\nDealer health (${Date.now() - t1} ms): ${health.length} dealers, ${withOwner} with owner, ${direct} direct onboardings`);
    const keys = new Set(health.map((h) => h.key));
    if (keys.size !== health.length) throw new Error("duplicate dealer health keys");
    console.log("✓ dealer health keys unique");
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
