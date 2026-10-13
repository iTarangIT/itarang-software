/**
 * Read-only check of the ID 88 Sales dashboard measures against real rows:
 * runs the real query builders (src/lib/dashboard/salesHeadMeasures.ts) for
 * this month and prints what the screen would show. Writes nothing.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id88-dashboard.ts [from] [to]
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { MEASURE_BUILDERS, type MeasureFilters } from "@/lib/dashboard/salesHeadMeasures";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}`);
    const [today] = rowsOf<{ d: string }>(await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`));
    const to = process.argv[3] ?? today.d;
    const from = process.argv[2] ?? `${to.slice(0, 8)}01`;
    const f: MeasureFilters = { from, to };
    console.log(`period: ${from} → ${to}\n`);

    const names = new Map(
        rowsOf<{ id: string; name: string | null }>(await db.execute(sql`SELECT id::text, name FROM users`)).map((u) => [u.id, u.name ?? u.id]),
    );
    const who = (id: string) => names.get(id) ?? id;

    let failures = 0;
    for (const [key, build] of Object.entries(MEASURE_BUILDERS)) {
        const t0 = Date.now();
        try {
            const out = await (build as (x: MeasureFilters) => Promise<unknown>)(f);
            console.log(`── ${key} (${Date.now() - t0} ms)`);
            if (Array.isArray(out)) {
                if (!out.length) console.log("   (no rows)");
                for (const r of out.slice(0, 12)) {
                    const row = r as Record<string, unknown>;
                    const id = (row.user_id ?? row.spoc ?? row.owner_id) as string | undefined;
                    console.log(`   ${id ? `${who(id)}: ` : ""}${JSON.stringify(r)}`);
                }
                if (out.length > 12) console.log(`   … ${out.length - 12} more`);
            } else {
                console.log(`   ${JSON.stringify(out)}`);
            }
        } catch (e) {
            failures++;
            console.log(`── ${key} FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // One person: every block narrows to them.
    const [busy] = rowsOf<{ u: string }>(
        await db.execute(sql`
            SELECT current_owner_id::text AS u FROM dealer_leads
             WHERE current_owner_id IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`),
    );
    if (busy) {
        console.log(`\nwith Person = ${who(busy.u)}:`);
        const one = { ...f, spoc_id: busy.u };
        const s = await MEASURE_BUILDERS.speed(one);
        console.log(`   speed ${JSON.stringify(s)}`);
        const st = await MEASURE_BUILDERS.stuck(one);
        console.log(`   stuck ${JSON.stringify(st)}`);
        const ok = st.every((r) => r.owner_id === busy.u);
        if (!ok) failures++;
        console.log(`   ${ok ? "PASS" : "FAIL"}  stuck rows are that person's only`);
    }

    console.log(failures ? `\n${failures} failure(s)` : "\nall builders ran");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
