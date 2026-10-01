// Tracker ID 59 — the four points of the 30 Sep review, checked against the
// database in DATABASE_URL. READ-ONLY: nothing is written.
//   node --import tsx --env-file=.env.local scripts/verify-id59-metrics.ts
//   node --import tsx --env-file=.env.local scripts/verify-id59-metrics.ts --settings
//
// --settings also proves the reports follow the engaged-call SETTING: inside a
// transaction that is always rolled back it saves three different rules and
// counts engaged calls under each. Nothing is left behind.
//
// Uses the real definitions (reports/metricDefinitions.ts) and the real
// builders (buildSalesDashboard, listTargets), so it measures what the
// dashboard, the targets page and the daily email will show. It also answers
// tracker question 5: what share of last month's calls were logged by hand.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import type { EngagedCallRule } from "@/lib/lifecycle/touchpointTypes";
import { getEngagedCallRuleSettings } from "@/lib/reports/engagedCallRule";
import { salesDailyDigest } from "@/lib/digests/kinds/sales-daily";
import {
    connectedCall,
    engagedCall,
    engagedCallCount,
    engagedState,
    humanCall,
    measuredCall,
} from "@/lib/reports/metricDefinitions";
import { listTargets } from "@/lib/targets/service";

let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const num = (v: unknown) => Number(v ?? 0);
type Row = Record<string, unknown>;
const one = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as Row[])[0] ?? {};
const many = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

async function main() {
    console.log("database:", new URL(process.env.DATABASE_URL!).host.split(".")[0]);
    const saved = await getEngagedCallRuleSettings();
    console.log(
        `engaged-call rule in force: connected and at least ${saved.minSeconds} s; ${
            saved.durationSource === "reported" ? "rep-entered durations count" : "NeoDove-recorded durations only"
        }${saved.updated_at ? ` (set by ${saved.updated_by_name ?? "—"})` : " (default — never changed)"}\n`,
    );
    const NEODOVE: EngagedCallRule = { minSeconds: saved.minSeconds, durationSource: "neodove" };
    const REPORTED: EngagedCallRule = { minSeconds: saved.minSeconds, durationSource: "reported" };

    // ── 1. engaged = measured duration ────────────────────────────────────
    const c = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${humanCall()})                        AS human,
               COUNT(*) FILTER (WHERE ${engagedCall(sql`t`, NEODOVE)})     AS engaged_neodove,
               COUNT(*) FILTER (WHERE ${engagedCall(sql`t`, REPORTED)})    AS engaged_reported,
               COUNT(*) FILTER (WHERE ${measuredCall(sql`t`, NEODOVE)})    AS measured_neodove,
               COUNT(*) FILTER (WHERE ${measuredCall(sql`t`, REPORTED)})   AS measured_reported,
               COUNT(*) FILTER (WHERE t.is_engaged IS TRUE)                  AS flagged,
               COUNT(*) FILTER (WHERE t.call_status = 'connected')           AS connected,
               ${engagedCallCount(sql`t`, NEODOVE)}                        AS count_neodove,
               ${engagedCallCount(sql`t`, REPORTED)}                       AS count_reported
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'inside_sales_call'`);
    console.log(
        `calls (all time): ${num(c.human)} human · ${num(c.connected)} connected rows · stored flag says engaged on ${num(c.flagged)}`,
    );
    console.log(
        `  NeoDove-recorded duration: ${num(c.measured_neodove)} measured, ${num(c.engaged_neodove)} engaged → report shows ${c.count_neodove == null ? '"Not measured yet"' : num(c.count_neodove)}`,
    );
    console.log(
        `  incl. rep-entered duration: ${num(c.measured_reported)} measured, ${num(c.engaged_reported)} engaged → report would show ${c.count_reported == null ? '"Not measured yet"' : num(c.count_reported)}`,
    );
    check(num(c.engaged_reported) <= num(c.human), "engaged never exceeds calls");
    check(num(c.engaged_neodove) <= num(c.engaged_reported), "a NeoDove-timed engaged call is also engaged when typed durations count");
    check(
        (c.count_neodove == null) === (num(c.measured_neodove) === 0),
        "engagedCallCount is NULL exactly when no call has a measured duration",
    );
    // With no explicit rule the fragments read the saved setting themselves.
    const inline = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${engagedCall()}) AS engaged, ${engagedCallCount()} AS shown
          FROM lead_touchpoints t WHERE t.touchpoint_type = 'inside_sales_call'`);
    const expected = saved.durationSource === "reported" ? c.engaged_reported : c.engaged_neodove;
    check(
        num(inline.engaged) === num(expected),
        "the fragments read the saved rule from the settings row",
        `${num(inline.engaged)} engaged under the rule in force`,
    );

    // ── the setting drives the reports (rolled back) ──────────────────────
    if (process.argv.includes("--settings")) {
        class Rollback extends Error {}
        try {
            await db.transaction(async (tx) => {
                const save = (value: unknown) =>
                    tx.execute(sql`
                        INSERT INTO app_settings (key, value, updated_at)
                        VALUES ('engaged_call_rule', ${JSON.stringify(value)}::jsonb, NOW())
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
                const engaged = async (rule?: EngagedCallRule) =>
                    num(
                        ((await tx.execute(sql`
                            SELECT COUNT(*) FILTER (WHERE ${engagedCall(sql`t`, rule)}) AS n
                              FROM lead_touchpoints t WHERE t.touchpoint_type = 'inside_sales_call'`)) as unknown as Row[])[0]?.n,
                    );

                await save({ min_seconds: 30, duration_source: "reported" });
                check(
                    (await engaged()) === (await engaged({ minSeconds: 30, durationSource: "reported" })),
                    'saving "rep-entered durations count" changes what the reports count',
                    `${await engaged()} engaged`,
                );
                await save({ min_seconds: 120, duration_source: "reported" });
                check(
                    (await engaged()) === (await engaged({ minSeconds: 120, durationSource: "reported" })),
                    "saving a different threshold changes it too",
                    `${await engaged()} engaged at 120 s`,
                );
                await save({ min_seconds: "abc", duration_source: 7 });
                check(
                    (await engaged()) === (await engaged({ minSeconds: 30, durationSource: "neodove" })),
                    "a malformed settings row falls back to the default instead of breaking the report",
                );
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        const after = await getEngagedCallRuleSettings();
        check(
            after.minSeconds === saved.minSeconds && after.durationSource === saved.durationSource,
            "the saved rule is as it was before the run",
        );
    }

    // ── 2. the per-row state every reader now uses ────────────────────────
    const s = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${engagedState()} IS TRUE)  AS yes,
               COUNT(*) FILTER (WHERE ${engagedState()} IS FALSE) AS no,
               COUNT(*) FILTER (WHERE ${engagedState()} IS NULL)  AS unknown,
               COUNT(*) FILTER (WHERE ${engagedState()} IS TRUE AND t.call_status IS DISTINCT FROM 'connected') AS bad
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'inside_sales_call'`);
    console.log(`\ncall rows by engaged state: ${num(s.yes)} yes · ${num(s.no)} no · ${num(s.unknown)} not measured`);
    check(num(s.bad) === 0, "no call that did not connect reads as engaged");

    const k = await one(sql`
        SELECT COUNT(*) FILTER (WHERE old_engaged) AS old_cohort,
               COUNT(*) FILTER (WHERE new_engaged) AS new_cohort
          FROM (
            SELECT EXISTS (SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = dl.id AND t.is_engaged IS TRUE) AS old_engaged,
                   EXISTS (SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = dl.id AND ${engagedState()} IS TRUE) AS new_engaged
              FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE AND dl.created_at >= NOW() - INTERVAL '30 days'
          ) x`);
    console.log(
        `Admin KPI "Engaged → Converted" cohort (leads created last 30 days): ${num(k.old_cohort)} by the old flag → ${num(k.new_cohort)} by the definition`,
    );
    check(num(k.new_cohort) <= num(k.old_cohort), "the definition never engages a lead the old flag did not");

    // ── connected calls, counted once (admin Daily Activity report) ────────
    const cc = await one(sql`
        SELECT COUNT(*) FILTER (WHERE t.call_status = 'connected') AS connected_rows,
               COUNT(*) FILTER (WHERE ${connectedCall()})          AS connected_calls,
               COUNT(*) FILTER (WHERE ${humanCall()})              AS human
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'inside_sales_call' AND t.performed_by IS NOT NULL
           AND t.performed_at >= NOW() - INTERVAL '30 days'`);
    console.log(
        `\nDaily Activity "Connected Calls", last 30 days: ${num(cc.connected_rows)} connected rows → ${num(cc.connected_calls)} connected calls (of ${num(cc.human)} calls)`,
    );
    check(num(cc.connected_calls) <= num(cc.connected_rows), "de-duplicating never adds a connected call");
    check(num(cc.connected_calls) <= num(cc.human), "connected never exceeds calls");

    // ── 4. dealers visited: one figure in the email and the targets ───────
    const today = String((await one(sql`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d);
    for (const month of [today.slice(0, 7), prevMonth(today)]) {
        const from = `${month}-01`;
        const to = month === today.slice(0, 7) ? today : monthEnd(from);
        const [dash, targets] = await Promise.all([
            buildSalesDashboard({ from, to, city: null, state: null, spoc_id: null, business_type: null, granularity: "month" }),
            listTargets({ month }).catch(() => []),
        ]);
        const reps = (dash.per_spoc ?? []).filter((b) => b.totals.visits > 0);
        const repeat = reps.filter((b) => b.totals.visits !== b.totals.unique_visits).length;
        console.log(
            `\n${month}: ${dash.totals.visits} visits to ${dash.totals.unique_visits} distinct dealers; ${reps.length} people visited, ${repeat} of them visited some dealer more than once`,
        );
        const rows = targets.filter((t) => t.metric === "dealer_visits");
        if (month !== today.slice(0, 7)) continue; // listTargets measures a past month to its last day; same check, once
        if (rows.length === 0) {
            console.log("  no dealer_visits target this month — nothing to compare");
            continue;
        }
        const byUser = new Map((dash.per_spoc ?? []).map((b) => [b.spoc_id, b.totals.unique_visits]));
        const wrong = rows.filter((t) => t.progress.actual !== (byUser.get(t.user_id) ?? 0));
        check(
            wrong.length === 0,
            `targets "Dealer visits" actual = distinct dealers visited, for all ${rows.length} people with the target`,
            wrong.map((t) => `${t.user_name}: ${t.progress.actual} vs ${byUser.get(t.user_id) ?? 0}`).join("; "),
        );
    }

    // ── the email itself (built, never sent) ──────────────────────────────
    const covered = String((await one(sql`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS d`)).d);
    const mail = await salesDailyDigest.collect(covered);
    check(mail.ok, `Sales Daily email builds for ${covered}`, mail.error ?? "");
    const tables = ((mail.figures as { tables?: Array<{ key: string; columns: string[]; rows: unknown[][]; note?: string }> }).tables ?? []);
    const a = tables.find((t) => t.key === "block_a");
    const cBlock = tables.find((t) => t.key === "block_c");
    const engagedRow = a?.rows.find((r) => r[0] === "Engaged calls");
    console.log(`  A · Engaged calls → ${engagedRow ? engagedRow.slice(1).filter((x) => x !== "").join(" | ") : "(row missing)"}`);
    check(!!engagedRow, "Block A has the Engaged calls row");
    check(
        !!cBlock && ["Connected MTD", "Connect % MTD", "Engaged MTD", "Hot to field MTD"].every((h) => cBlock.columns.includes(h)),
        "Block C carries Connected, Connect %, Engaged and Hot to field per rep",
    );
    for (const r of cBlock?.rows ?? []) console.log(`  C · ${r.join(" | ")}`);
    check(
        (cBlock?.rows ?? []).every((r) => r.length === cBlock!.columns.length),
        "every Block C row has a cell for every column",
    );

    // ── question 5: how many calls are logged by hand? ────────────────────
    const lastMonth = prevMonth(today);
    const q5 = await many(sql`
        SELECT COALESCE(u.role, '(unmapped NeoDove agent)') AS role,
               COUNT(*) FILTER (WHERE t.external_system = 'neodove') AS via_neodove,
               COUNT(*) FILTER (WHERE t.external_system IS DISTINCT FROM 'neodove') AS by_hand
          FROM lead_touchpoints t
          LEFT JOIN users u ON u.id::text = t.performed_by
         WHERE ${humanCall()}
           AND to_char(t.performed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = ${lastMonth}
         GROUP BY 1 ORDER BY 2 DESC`);
    console.log(`\nQuestion 5 — human calls in ${lastMonth}, by who made them:`);
    let neo = 0;
    let hand = 0;
    for (const r of q5) {
        neo += num(r.via_neodove);
        hand += num(r.by_hand);
        console.log(`  ${String(r.role).padEnd(26)} NeoDove ${String(num(r.via_neodove)).padStart(5)} · by hand ${String(num(r.by_hand)).padStart(4)}`);
    }
    const total = neo + hand;
    console.log(`  total ${total}: ${hand} by hand = ${total ? ((hand / total) * 100).toFixed(1) : "0"}%`);

    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
}

function prevMonth(day: string): string {
    const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
}
function monthEnd(first: string): string {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
}

main()
    .catch((e) => {
        console.error(e);
        failed += 1;
    })
    .finally(() => process.exit(failed ? 1 : 0));
