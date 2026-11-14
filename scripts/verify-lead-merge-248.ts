// ID 248 — sandbox check of the lead merge, on two TEST leads it creates itself (never on
// real leads, never on live: it refuses the database-2 host).
//
//   node --import tsx --env-file=.env.local scripts/verify-lead-merge-248.ts
//
// Builds TEST-248-<run>-A (older, number as 10 digits, one done visit on day D) and
// TEST-248-<run>-B (same number with +91, one done visit on day D + one call), merges B
// into A, and checks: B's call is on A; B's same-day visit is cancelled so A counts one
// visit that day; B is Lost (duplicate_lead); A's empty city was filled from B. The two
// test leads stay behind (A open, B Lost), named "TEST 248 merge" so they are easy to find.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { mergeDealerLeads, planMerge } from "@/lib/leads/mergeLeads";

function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) process.exitCode = 1;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);

    const run = Date.now().toString(36);
    const A = `TEST-248-${run}-A`;
    const B = `TEST-248-${run}-B`;
    const digits = `9${String(Date.now()).slice(-9)}`;
    const admin = ((await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'admin' AND is_active LIMIT 1`)) as unknown as Array<{ id: string }>)[0];
    const asm = ((await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'asm' AND is_active ORDER BY name LIMIT 1`)) as unknown as Array<{ id: string }>)[0];
    if (!admin || !asm) throw new Error("need an active admin and an active ASM on the sandbox");
    const day = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

    await db.execute(sql`
        INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, lead_status, created_at, updated_at)
        VALUES (${A}, 'TEST 248 merge', 'TEST 248 merge (kept)', ${digits}, 'Under_Discussion', NOW() - interval '30 days', NOW()),
               (${B}, 'TEST 248 merge', 'TEST 248 merge (copy)', ${`+91${digits}`}, 'Assigned_Not_Contacted', NOW() - interval '10 days', NOW())
    `);
    await db.execute(sql`UPDATE dealer_leads SET city = 'Testpur' WHERE id = ${B}`);
    await db.execute(sql`
        INSERT INTO lead_visits (dealer_lead_id, asm_id, visit_status, actual_visit_date, visit_outcome, created_at, updated_at)
        VALUES (${A}, ${asm.id}, 'visited', ${day}::date, 'productive', NOW(), NOW()),
               (${B}, ${asm.id}, 'visited', ${day}::date, 'productive', NOW(), NOW())
    `);
    await db.execute(sql`
        INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks)
        VALUES (${B}, 'inside_sales_call', ${asm.id}, NOW() - interval '2 days', 'TEST 248: call on the copy')
    `);
    // A table that allows one row per lead, on BOTH copies: the merge must keep B's row on B
    // (a unique clash) and still finish (14 Nov: the raw SAVEPOINT version aborted here).
    await db.execute(sql`
        INSERT INTO dealer_lead_phone_type (lead_id, phone, phone_type) VALUES (${A}, ${digits}, 'mobile'), (${B}, ${digits}, 'mobile')
        ON CONFLICT DO NOTHING
    `);
    console.log(`Created ${A} (…${digits.slice(-4)}) and ${B} (+91…${digits.slice(-4)}), a done visit on ${day} on each, one call on ${B}.\n`);

    // Refuses to keep the newer lead.
    let refused = false;
    try {
        await planMerge(B, A);
    } catch {
        refused = true;
    }
    check(refused, "keeping the NEWER lead is refused");

    const plan = await planMerge(A, B);
    check(plan.sameDayVisits === 1, `plan: 1 same-day visit (got ${plan.sameDayVisits})`);
    check(plan.moves.some((m) => m.table === "lead_touchpoints" && m.rows === 1), "plan: B's call moves");

    const r = await mergeDealerLeads({ keepId: A, dropId: B, actor: { id: admin.id, role: "admin" } });
    console.log(`  moved: ${r.moved.map((m) => `${m.table}.${m.column}=${m.rows}`).join(", ") || "none"}`);
    console.log(`  kept on the copy: ${r.keptOnCopy.map((k) => `${k.table}.${k.column}`).join(", ") || "none"}`);

    const calls = (await db.execute(sql`SELECT count(*)::int AS n FROM lead_touchpoints WHERE dealer_lead_id = ${A} AND remarks = 'TEST 248: call on the copy'`)) as unknown as Array<{ n: number }>;
    check(calls[0]?.n === 1, "B's call is on A");
    const visits = (await db.execute(sql`
        SELECT count(*) FILTER (WHERE visit_status = 'visited')::int AS done, count(*)::int AS all_rows
          FROM lead_visits WHERE dealer_lead_id = ${A} AND actual_visit_date = ${day}::date
    `)) as unknown as Array<{ done: number; all_rows: number }>;
    check(visits[0]?.done === 1 && visits[0]?.all_rows === 2, `A counts ONE done visit on ${day} (rows ${visits[0]?.all_rows}, done ${visits[0]?.done})`);
    const b = (await db.execute(sql`SELECT lead_status, lost_reason FROM dealer_leads WHERE id = ${B}`)) as unknown as Array<{ lead_status: string; lost_reason: string }>;
    check(b[0]?.lead_status === "Lost" && b[0]?.lost_reason === "duplicate_lead", `B is Lost / duplicate_lead (got ${b[0]?.lead_status} / ${b[0]?.lost_reason})`);
    const a = (await db.execute(sql`SELECT city, lead_status FROM dealer_leads WHERE id = ${A}`)) as unknown as Array<{ city: string; lead_status: string }>;
    check(a[0]?.city === "Testpur", "A's empty city filled from B");
    check(a[0]?.lead_status === "Under_Discussion", "A keeps its own status");
    const marks = (await db.execute(sql`SELECT count(*)::int AS n FROM dealer_lead_field_changes WHERE field IN ('merged_from', 'merged_into') AND dealer_lead_id IN (${A}, ${B})`)) as unknown as Array<{ n: number }>;
    check(marks[0]?.n === 2, "merge recorded on both leads");
    check(
        r.keptOnCopy.some((k) => k.table === "dealer_lead_phone_type"),
        "a one-row-per-lead table that clashes stays on the copy, and the merge still finishes",
    );

    let again = false;
    try {
        await mergeDealerLeads({ keepId: A, dropId: B, actor: { id: admin.id, role: "admin" } });
        const tp = (await db.execute(sql`SELECT count(*)::int AS n FROM lead_touchpoints WHERE dealer_lead_id = ${A} AND remarks = 'TEST 248: call on the copy'`)) as unknown as Array<{ n: number }>;
        again = tp[0]?.n === 1;
    } catch {
        again = true;
    }
    check(again, "running the same merge again changes nothing");
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
