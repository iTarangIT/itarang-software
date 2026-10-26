/**
 * ID 183 — read-only check of the iTarang team credit line on the Team
 * scorecard (src/lib/admin/itarangAssistScore.ts) against the raw
 * ACTED_FOR_DEALER audit rows for the same IST days.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id183-team-credit.ts [from] [to]
 *
 * Default window: 1 Oct to today (IST). Writes nothing.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildItarangAssistScore } from "@/lib/admin/itarangAssistScore";
import { ACTED_FOR_DEALER } from "@/lib/leads/actForDealer";

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const from = process.argv[2] ?? `${today.slice(0, 8)}01`;
    const to = process.argv[3] ?? today;

    const [raw] = (await db.execute(sql`
        SELECT COUNT(DISTINCT entity_id)::int AS files, COUNT(*)::int AS steps
          FROM audit_logs
         WHERE entity_type = 'lead' AND action = ${ACTED_FOR_DEALER}
           AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ files: number; steps: number }>;

    const score = await buildItarangAssistScore({ from, to });
    console.log(`window ${from} .. ${to}`);
    console.log(`audit rows: ${raw.files} files, ${raw.steps} steps`);
    console.log(`scorecard:  ${score.files} files, ${score.steps} steps`);
    for (const p of score.people) console.log(`  ${p.name.padEnd(28)} ${p.files} files  ${p.steps} steps  (${p.user_id ?? "no user"})`);

    const bad = raw.files !== score.files || raw.steps !== score.steps;
    console.log(bad ? "MISMATCH" : "OK");
    process.exit(bad ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
