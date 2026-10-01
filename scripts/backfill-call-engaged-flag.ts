// Tracker ID 59 — re-align the STORED lead_touchpoints.is_engaged on call rows
// with the engaged-call rule.
//
//   node --import tsx --env-file=.env.local scripts/backfill-call-engaged-flag.ts            dry run
//   node --import tsx --env-file=.env.local scripts/backfill-call-engaged-flag.ts --apply
//
// WHY. Until 01 Oct 2026 writers stored is_engaged = "the call connected" (or a
// rep's tick). The CRM's own reports no longer read the flag for a call — they
// compute engagedState() — so nothing in the app needs this. It is for anything
// that reads the column DIRECTLY (a SQL export, a BI tool, a future query that
// forgets the definition): after it, the column says what the reports say.
//
// WHAT. Only touchpoint_type = 'inside_sales_call' rows. Visits, WhatsApp and
// notes keep their flag. New value = engagedState() IS TRUE under the SAVED rule
// (app_settings 'engaged_call_rule'): connected, a measured duration, at least
// the threshold. A connected call with no measured duration becomes FALSE — the
// column has no "not measured"; call_status still says it connected.
//
// REVERSIBLE. --apply first writes every changed row's id and old value to
// scripts/_backfill-call-engaged-flag.<database>.<timestamp>.json; --restore
// <file> puts them back. If the rule is changed later (tracker question 6),
// run this again: it moves only the rows the new rule judges differently.
// Idempotent — a second run changes nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getEngagedCallRuleSettings } from "@/lib/reports/engagedCallRule";
import { engagedState } from "@/lib/reports/metricDefinitions";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

async function main() {
    const apply = process.argv.includes("--apply");
    const restoreAt = process.argv.indexOf("--restore");
    const database = new URL(process.env.DATABASE_URL!).host.split(".")[0];
    console.log("database:", database);

    if (restoreAt > -1) {
        const file = process.argv[restoreAt + 1];
        if (!file) throw new Error("usage: --restore <file written by --apply>");
        const saved = JSON.parse(readFileSync(file, "utf8")) as { database: string; rows: Array<{ id: string; was: boolean | null }> };
        if (saved.database !== database) throw new Error(`that file is for ${saved.database}, this is ${database}`);
        let restored = 0;
        await db.transaction(async (tx) => {
            for (const was of [true, false, null]) {
                const ids = saved.rows.filter((r) => r.was === was).map((r) => r.id);
                for (let i = 0; i < ids.length; i += 1000) {
                    const chunk = ids.slice(i, i + 1000);
                    const out = (await tx.execute(sql`
                        UPDATE lead_touchpoints SET is_engaged = ${was}
                         WHERE touchpoint_id::text IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
                        RETURNING touchpoint_id`)) as unknown as Row[];
                    restored += out.length;
                }
            }
        });
        console.log(`restored ${restored} of ${saved.rows.length} rows`);
        return;
    }

    const rule = await getEngagedCallRuleSettings();
    console.log(
        `rule: connected and at least ${rule.minSeconds} s; ${
            rule.durationSource === "reported" ? "rep-entered durations count" : "NeoDove-recorded durations only"
        }`,
    );

    const WRONG = sql`t.touchpoint_type = 'inside_sales_call'
        AND COALESCE(t.is_engaged, FALSE) IS DISTINCT FROM COALESCE(${engagedState()}, FALSE)`;

    const summary = (await db.execute(sql`
        SELECT COALESCE(t.external_system, '(logged by hand)') AS source,
               COUNT(*) FILTER (WHERE t.is_engaged IS TRUE)  AS true_to_false,
               COUNT(*) FILTER (WHERE t.is_engaged IS NOT TRUE) AS false_to_true
          FROM lead_touchpoints t
         WHERE ${WRONG}
         GROUP BY 1 ORDER BY 2 DESC`)) as unknown as Row[];
    const total = summary.reduce((a, r) => a + num(r.true_to_false) + num(r.false_to_true), 0);
    const [all] = (await db.execute(sql`
        SELECT COUNT(*) AS n FROM lead_touchpoints t WHERE t.touchpoint_type = 'inside_sales_call'`)) as unknown as Row[];
    console.log(`\n${total} of ${num(all.n)} call rows carry a flag the rule disagrees with:`);
    for (const r of summary) {
        console.log(
            `  ${String(r.source).padEnd(18)} engaged → not engaged: ${num(r.true_to_false)} · not engaged → engaged: ${num(r.false_to_true)}`,
        );
    }

    if (!apply) {
        console.log("\ndry run — nothing written. Re-run with --apply to change them.");
        return;
    }
    if (total === 0) {
        console.log("\nnothing to change.");
        return;
    }

    const changed = await db.transaction(async (tx) => {
        const before = (await tx.execute(sql`
            SELECT t.touchpoint_id::text AS id, t.is_engaged AS was
              FROM lead_touchpoints t WHERE ${WRONG} FOR UPDATE`)) as unknown as Array<{ id: string; was: boolean | null }>;
        const file = `scripts/_backfill-call-engaged-flag.${database}.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        writeFileSync(file, JSON.stringify({ database, rule, written_at: new Date().toISOString(), rows: before }));
        console.log(`\nold values of ${before.length} rows saved to ${file}`);
        const out = (await tx.execute(sql`
            UPDATE lead_touchpoints t
               SET is_engaged = COALESCE(${engagedState()}, FALSE)
             WHERE ${WRONG}
            RETURNING t.touchpoint_id`)) as unknown as Row[];
        if (out.length !== before.length) throw new Error(`expected ${before.length} rows, updated ${out.length} — rolled back`);
        return out.length;
    });
    const [left] = (await db.execute(sql`SELECT COUNT(*) AS n FROM lead_touchpoints t WHERE ${WRONG}`)) as unknown as Row[];
    console.log(`updated ${changed} rows; ${num(left.n)} still disagree (expected 0)`);
    if (num(left.n) !== 0) process.exitCode = 1;
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
