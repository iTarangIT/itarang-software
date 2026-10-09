// Read-only check of the ID 144 call-timing grid against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-id144-call-timing.ts [from] [to]
//
// 1. The grid (getCallTimingGrid) must hold exactly as many dials as there are
//    dialled attempts in attempt_history (+ pre-history rows), counted here
//    independently in the same date range.
// 2. answered ≤ dials and talked ≤ answered in every cell.
// 3. Prints the by-hour profile and the suggested calling hours.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getCallTimingGrid } from "@/lib/ai-dialer/callTiming";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const [from = "2026-01-01", to = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  range ${from} → ${to}\n`);

    const t0 = Date.now();
    const grid = await getCallTimingGrid({ from, to, campaignId: null, state: null, city: null });
    console.log(`grid built in ${Date.now() - t0} ms`);

    // Independent count: every attempt with a dialled status, timed by its
    // call log when there is one, else by the attempt's recorded time.
    const [ref] = (await db.execute(sql`
        WITH att AS (
            SELECT h ->> 'status' AS status, NULLIF(h ->> 'call_id', '') AS call_id, (h ->> 'at')::timestamptz AS at
              FROM dialer_campaign_leads dcl, jsonb_array_elements(dcl.attempt_history) h
             WHERE jsonb_typeof(dcl.attempt_history) = 'array'
            UNION ALL
            SELECT status, bolna_call_id, COALESCE(started_at, completed_at)
              FROM dialer_campaign_leads
             WHERE jsonb_typeof(attempt_history) IS DISTINCT FROM 'array' OR jsonb_array_length(attempt_history) = 0
        )
        SELECT COUNT(*)::int AS dials,
               COUNT(*) FILTER (WHERE att.status = 'completed')::int AS talked
          FROM att LEFT JOIN ai_call_logs acl ON acl.call_id = att.call_id
         WHERE att.status NOT IN ('failed', 'skipped', 'pending', 'calling')
           AND COALESCE(acl.created_at, att.at) >= (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
           AND COALESCE(acl.created_at, att.at) <  ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
    `)) as unknown as Array<{ dials: number; talked: number }>;

    check(`grid dials = attempts in range (${ref.dials})`, grid.total.dials === ref.dials, grid.total);
    check(`grid talked = completed attempts (${ref.talked})`, grid.total.talked === ref.talked);
    const bad = grid.cells.flat().filter((c) => c.answered > c.dials || c.talked > c.answered);
    check("every cell: talked ≤ answered ≤ dials", bad.length === 0, bad.slice(0, 3));

    console.log("\nby hour (IST) dials/answered/talked:");
    console.log(
        grid.byHour
            .map((c, h) => (c.dials ? `${String(h).padStart(2, "0")}h ${c.dials}/${c.answered}/${c.talked}` : null))
            .filter(Boolean)
            .join("  "),
    );
    console.log("suggestion:", grid.suggestion);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
