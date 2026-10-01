/**
 * Verifier for tracker ID 58 — a rep's queue export is limited to the leads
 * they own IN THE QUERY, so the row cap is taken over their own leads.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-export-own-leads.ts
 *
 * Runs the REAL queue builders against whatever DATABASE_URL points at.
 * Read-only: SELECTs only. Exit code 1 if anything FAILs.
 *
 * The check that matters is the small-limit one. Before the fix the export
 * fetched the first N rows of the tab and filtered to the rep's leads
 * afterwards, so a rep whose leads sort below row N got a short (or empty)
 * sheet. With the owner filter in the query, asking for the first 3 rows of a
 * big shared tab returns 3 of the rep's OWN leads.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { countQueueRows, fetchQueueRows, tabFilter } from "../src/lib/inside-sales/queryBuilder";
import {
    LATEST_VISIT_JOIN,
    countAsmQueueRows,
    fetchAsmQueueRows,
    tabFilter as asmTabFilter,
} from "../src/lib/asm/queryBuilder";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];

async function check(id: string, fn: () => Promise<string>) {
    try {
        results.push({ id, outcome: "PASS", note: await fn() });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ id, outcome: msg.startsWith("SKIP") ? "SKIP" : "FAIL", note: msg });
    }
}
function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

/** The user who owns the most open leads — the one a short sheet would hurt. */
async function busiestOwner(role: string): Promise<{ id: string; n: number } | null> {
    const rows = (await db.execute<{ id: string; n: number }>(sql`
        SELECT dl.current_owner_id AS id, COUNT(*)::int AS n
          FROM dealer_leads dl
          JOIN users u ON u.id::text = dl.current_owner_id
         WHERE u.role = ${role}
           AND dl.is_active IS NOT FALSE
           AND dl.lead_status IS DISTINCT FROM 'Converted'
           AND dl.lead_status IS DISTINCT FROM 'Lost'
         GROUP BY dl.current_owner_id
         ORDER BY COUNT(*) DESC
         LIMIT 1
    `)) as unknown as Array<{ id: string; n: number }>;
    return rows[0] ?? null;
}

async function main() {
    await check("inside-sales queue export — owner filter is in the query", async () => {
        const rep = await busiestOwner("inside_sales_rep");
        if (!rep) throw new Error("SKIP: no inside_sales_rep owns an open lead on this database");
        const args = { tab: "team" as const, userId: rep.id };

        const [expected] = (await db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM dealer_leads dl
             WHERE ${tabFilter("team", rep.id)} AND dl.current_owner_id = ${rep.id}
        `)) as unknown as Array<{ n: number }>;
        const [whole, own, top] = await Promise.all([
            countQueueRows(args),
            countQueueRows({ ...args, ownedBy: rep.id }),
            fetchQueueRows({ ...args, page: 1, limit: 3, ownedBy: rep.id }),
        ]);

        assert(own === expected.n, `count with ownedBy = ${own}, expected ${expected.n}`);
        assert(own <= whole, `own ${own} exceeds the whole tab ${whole}`);
        assert(top.every((r) => r.current_owner_id === rep.id), "a row owned by someone else came back");
        assert(top.length === Math.min(3, own), `asked for 3 own rows, got ${top.length} of ${own}`);
        return `rep ${rep.id}: ${own} own of ${whole} in Team; first ${top.length} rows are all theirs`;
    });

    await check("ASM queue export — owner filter is in the query", async () => {
        const asm = await busiestOwner("asm");
        if (!asm) throw new Error("SKIP: no asm owns an open lead on this database");
        const args = { tab: "territory" as const, asmId: asm.id };

        const [expected] = (await db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM dealer_leads dl ${LATEST_VISIT_JOIN}
             WHERE ${asmTabFilter("territory", asm.id)} AND dl.current_owner_id = ${asm.id}
        `)) as unknown as Array<{ n: number }>;
        const [whole, own, top] = await Promise.all([
            countAsmQueueRows(args),
            countAsmQueueRows({ ...args, ownedBy: asm.id }),
            fetchAsmQueueRows({ ...args, page: 1, limit: 3, ownedBy: asm.id }),
        ]);

        assert(own === expected.n, `count with ownedBy = ${own}, expected ${expected.n}`);
        assert(own <= whole, `own ${own} exceeds the whole tab ${whole}`);
        assert(top.every((r) => r.current_owner_id === asm.id), "a row owned by someone else came back");
        assert(top.length === Math.min(3, own), `asked for 3 own rows, got ${top.length} of ${own}`);
        // own = 0 is a real result, not a vacuous one: the feed is mostly the
        // unowned pool, and none of it may reach an ASM's sheet.
        return own === 0
            ? `asm ${asm.id}: Territory Feed has ${whole} rows, none owned by them — the export returns 0`
            : `asm ${asm.id}: ${own} own of ${whole} in Territory Feed; first ${top.length} rows are all theirs`;
    });

    await check("without ownedBy the builders are unchanged (managers, the list screens)", async () => {
        const rep = await busiestOwner("inside_sales_rep");
        if (!rep) throw new Error("SKIP: no inside_sales_rep owns an open lead on this database");
        const [plain, nulled] = await Promise.all([
            countQueueRows({ tab: "team", userId: rep.id }),
            countQueueRows({ tab: "team", userId: rep.id, ownedBy: null }),
        ]);
        assert(plain === nulled, `ownedBy: null changed the count (${plain} vs ${nulled})`);
        return `Team = ${plain} either way`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
