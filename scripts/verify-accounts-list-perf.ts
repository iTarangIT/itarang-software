// Accounts screen speed — read-only timing of the /admin/accounts queries.
//
//   node --import tsx --env-file=.env.local scripts/verify-accounts-list-perf.ts
//
// Runs, inside a READ ONLY transaction, EXPLAIN ANALYZE of the real builders
// (lib/accounts/accountsScreen + ownership.suggestedOwners) for the Live and
// No owner tabs, and times the suggested-owner hint for the unowned accounts
// on page 1 both ways: the current suggestedOwners() and the pre-E-357 OR-join
// form (restated below ONLY as the "before" baseline). Says which E-357
// indexes exist.
// Writes nothing.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountsPageSql, accountsTabCountsSql, accountsTotalSql } from "@/lib/accounts/accountsScreen";
import { suggestedOwners } from "@/lib/accounts/ownership";
import { GSTIN_KEY, gstinKeyIsMatchable } from "@/lib/leads/gstinMatch";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
type Runner = Parameters<typeof suggestedOwners>[1];

async function explain(runner: NonNullable<Runner>, label: string, q: SQL) {
    const res = rowsOf<{ "QUERY PLAN": Array<{ "Execution Time": number; "Planning Time": number }> }>(
        await runner.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${q}`),
    );
    const plan = res[0]?.["QUERY PLAN"]?.[0];
    console.log(`  ${label.padEnd(34)} exec ${plan?.["Execution Time"]?.toFixed(1)} ms  (plan ${plan?.["Planning Time"]?.toFixed(1)} ms)`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    const out = await fn();
    console.log(`  ${label.padEnd(34)} ${(performance.now() - t).toFixed(1)} ms wall`);
    return out;
}

/** The rank-7 OR join as it was before this change — baseline only. */
function oldRank7(ids: string[]): SQL {
    const last10 = (expr: SQL): SQL => sql`right(regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), 10)`;
    return sql`
        WITH acc AS (SELECT a.id AS account_id, a.gstin, a.contact_phone FROM accounts a
                      WHERE a.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}))
        SELECT acc.account_id, sl.closing_owner_id
          FROM acc
          JOIN dealer_leads sl
            ON (${gstinKeyIsMatchable(GSTIN_KEY(sql`acc.gstin`))}
                AND ${GSTIN_KEY(sql`sl.gstin`)} = ${GSTIN_KEY(sql`acc.gstin`)})
            OR (length(${last10(sql`acc.contact_phone`)}) = 10
                AND ${last10(sql`sl.phone`)} = ${last10(sql`acc.contact_phone`)})`;
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);

    await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const runner = tx as unknown as NonNullable<Runner>;

        const idx = rowsOf<{ indexname: string }>(
            await tx.execute(sql`SELECT indexname FROM pg_indexes WHERE indexname IN (
                'dealer_onboarding_applications_dealer_code_idx', 'dealer_leads_onboarding_application_idx',
                'dealer_leads_gstin_key_idx', 'dealer_leads_phone_last10_idx')`),
        ).map((r) => r.indexname);
        console.log(`E-357 indexes present: ${idx.length}/4 ${idx.length ? `(${idx.join(", ")})` : ""}\n`);

        const n = rowsOf<{ accounts: number; leads: number }>(
            await tx.execute(sql`SELECT (SELECT count(*) FROM accounts)::int AS accounts, (SELECT count(*) FROM dealer_leads)::int AS leads`),
        )[0];
        console.log(`accounts ${n?.accounts} · dealer_leads ${n?.leads}\n`);

        console.log("List / counts (EXPLAIN ANALYZE):");
        await explain(runner, "page 1, Live", await accountsPageSql({}, 100, 0));
        await explain(runner, "total, Live", await accountsTotalSql({}));
        await explain(runner, "page 1, No owner", await accountsPageSql({ owner: "none" }, 100, 0));
        await explain(runner, "page 1, GSTIN missing", await accountsPageSql({ gstin_missing: true }, 100, 0));
        await explain(runner, "page 1, search 'kar'", await accountsPageSql({ q: "kar" }, 100, 0));
        await explain(runner, "tab counts", await accountsTabCountsSql());

        const page = rowsOf<{ id: string; owner_user_id: string | null }>(
            await tx.execute(await accountsPageSql({}, 100, 0)),
        );
        const unowned = page.filter((r) => !r.owner_user_id).map((r) => r.id);
        console.log(`\nSuggested owners for ${unowned.length} unowned accounts on page 1:`);
        if (unowned.length === 0) return;

        await explain(runner, "rank 7 BEFORE (OR join)", oldRank7(unowned));
        const fresh = await timed("suggestedOwners() now", () => suggestedOwners(unowned, runner));
        console.log(`  → ${fresh.size} accounts got a suggestion`);
        for (const [id, s] of [...fresh].slice(0, 5)) console.log(`    ${id}: ${s.name} (${s.basis})`);
    });
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
