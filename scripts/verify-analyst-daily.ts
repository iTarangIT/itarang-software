// 251 item 23 — the AI Analyst morning mail, built for real on the SANDBOX without sending it.
// Refuses the live database (database-2).
//
//   NODE_PATH=<dir holding an empty server-only package> node --import tsx --env-file=.env.local scripts/verify-analyst-daily.ts
//
// (lib/analyst/client.ts imports "server-only", which only Next resolves; outside Next a
// stand-in folder <dir>/server-only/{package.json,index.js} with an empty index.js does.)
//
// Adds one morning question for an active CEO/admin (on the iTarang database source), checks
// the person now appears in the mail's list, builds their mail (one real run on the agent),
// prints it, and then stops the question again unless it was already on their list.
// Also checks: a sixth question is refused, and the same question twice is one row.

import { sql } from "drizzle-orm";

import { agentJson } from "@/lib/analyst/client";
import { addDaily, DAILY_QUESTIONS_MAX, dailyPeople, hasDailyTable, listDaily, stopDaily } from "@/lib/analyst/dailyStore";
import { CRM_SOURCE_NAME } from "@/lib/analyst/sources-routes";
import type { Connection } from "@/lib/analyst/types";
import { db } from "@/lib/db";
import { analystDailyDigest } from "@/lib/digests/kinds/analyst-daily";

const QUESTION = "Visits by each salesperson yesterday";

function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) process.exitCode = 1;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);
    if (!(await hasDailyTable())) throw new Error("E-385 is not applied here");

    const [person] = (await db.execute(sql`
        SELECT id::text AS id, COALESCE(name, email) AS name, trim(email) AS email, lower(role) AS role
          FROM users WHERE is_active AND lower(role) IN ('ceo', 'admin') AND email IS NOT NULL
         ORDER BY (lower(role) = 'ceo') DESC, name LIMIT 1
    `)) as unknown as Array<{ id: string; name: string; email: string; role: string }>;
    if (!person) throw new Error("no active CEO / admin on this database");
    console.log(`Person: ${person.name} (${person.role})\n`);

    const sources = await agentJson<Connection[]>("/connections");
    const crm = sources.find((s) => s.name === CRM_SOURCE_NAME);
    if (!crm) throw new Error(`no "${CRM_SOURCE_NAME}" source on the agent`);

    const before = await listDaily(person.id);
    const hadIt = before.some((q) => q.question.toLowerCase() === QUESTION.toLowerCase());
    const added = await addDaily({ userId: person.id, connectionId: crm.id, question: QUESTION, sourceRunId: null });
    check(added.ok, `added "${QUESTION}"`);
    const twice = await addDaily({ userId: person.id, connectionId: crm.id, question: `  ${QUESTION.toUpperCase()} `, sourceRunId: null });
    check(twice.ok && twice.already && added.ok && twice.item.id === added.item.id, "the same question twice is one row");

    const people = await dailyPeople(["ceo", "sales_head", "admin"]);
    check(people.some((p) => p.id === person.id), "the person is on the morning mail's list");

    // Fill up to the cap with throwaway questions, check a sixth is refused, take them out again.
    const extra: string[] = [];
    for (let i = (await listDaily(person.id)).length; i < DAILY_QUESTIONS_MAX; i++) {
        const r = await addDaily({ userId: person.id, connectionId: crm.id, question: `TEST 23 cap ${i}`, sourceRunId: null });
        if (r.ok) extra.push(r.item.id);
    }
    const sixth = await addDaily({ userId: person.id, connectionId: crm.id, question: "TEST 23 one too many", sourceRunId: null });
    check(!sixth.ok, `a question over the ${DAILY_QUESTIONS_MAX} cap is refused`);
    for (const id of extra) await stopDaily(id, person.id);

    // The real mail for this person (asks the agent; nothing is sent).
    const started = Date.now();
    const built = await analystDailyDigest.perRecipient!.collect("2026-11-15", person);
    console.log(`\nmail built in ${Math.round((Date.now() - started) / 1000)} s, ok=${built.ok}${built.error ? `, error: ${built.error}` : ""}`);
    for (const line of built.figures.headline ?? []) console.log(`  ${line}`);
    for (const t of built.figures.tables ?? []) {
        console.log(`\n  Q: ${t.title}`);
        if (t.note) console.log(`  A: ${t.note.slice(0, 400)}`);
        console.log(`  table: ${t.columns.join(" | ") || "(none)"}; ${t.rows.length} rows${t.rows.length ? "" : ` — ${t.empty}`}`);
        for (const row of t.rows.slice(0, 5)) console.log(`    ${row.join(" | ")}`);
    }
    const mine = built.figures.tables?.find((t) => t.title === QUESTION);
    check(built.ok && Boolean(mine) && Boolean(mine?.note || mine?.rows.length), "the question was answered afresh for the mail");

    if (!hadIt && added.ok && !added.already) {
        check(await stopDaily(added.item.id, person.id), "stopped again (it was not on their list before)");
    }
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
