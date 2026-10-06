// Tracker ID 59 — the metric definitions, checked against the database in
// DATABASE_URL. READ-ONLY: nothing is written.
//   node --import tsx --env-file=.env.local scripts/verify-id59-metrics.ts
//
// Engaged (decided 3 Oct 2026) = a connected human call, any duration. The
// duration rule and its setting are gone, so there is no --settings mode.
//
// Uses the real definitions (reports/metricDefinitions.ts) and the real
// builders (buildSalesDashboard, listTargets), so it measures what the
// dashboard, the targets page and the daily email will show. It also answers
// tracker question 5: what share of last month's calls were logged by hand.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { salesDailyDigest } from "@/lib/digests/kinds/sales-daily";
import {
    connectedCall,
    engagedCall,
    engagedState,
    humanCall,
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

    // ── 1. engaged = a connected human call, counted once ─────────────────
    const c = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${humanCall()})              AS human,
               COUNT(*) FILTER (WHERE ${engagedCall()})            AS engaged,
               COUNT(*) FILTER (WHERE ${connectedCall()})          AS connected_calls,
               COUNT(*) FILTER (WHERE t.is_engaged IS TRUE)        AS flagged,
               COUNT(*) FILTER (WHERE t.call_status = 'connected') AS connected_rows,
               COUNT(*) FILTER (WHERE ${engagedCall()} AND t.call_duration_sec IS NULL) AS engaged_untimed
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'inside_sales_call'`);
    console.log(
        `calls (all time): ${num(c.human)} human · ${num(c.connected_rows)} connected rows · ${num(c.engaged)} engaged · stored flag says engaged on ${num(c.flagged)}`,
    );
    check(num(c.engaged) === num(c.connected_calls), "engaged = connected human calls, counted once");
    check(num(c.engaged) <= num(c.human), "engaged never exceeds calls");
    check(num(c.engaged) <= num(c.connected_rows), "de-duplicating never adds an engaged call");
    console.log(`  ${num(c.engaged_untimed)} engaged calls carry no duration — they count all the same`);

    // ── 2. the per-row state every reader now uses ────────────────────────
    const s = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${engagedState()} IS TRUE)  AS yes,
               COUNT(*) FILTER (WHERE ${engagedState()} IS FALSE) AS no,
               COUNT(*) FILTER (WHERE ${engagedState()} IS NULL)  AS unknown,
               COUNT(*) FILTER (WHERE ${engagedState()} IS TRUE AND t.call_status IS DISTINCT FROM 'connected') AS bad,
               COUNT(*) FILTER (WHERE ${engagedState()} IS NOT TRUE AND t.call_status = 'connected') AS missed
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'inside_sales_call'`);
    console.log(`\ncall rows by engaged state: ${num(s.yes)} yes · ${num(s.no)} no`);
    check(num(s.unknown) === 0, "every call row reads Yes or No — never blank");
    check(num(s.missed) === 0, "every connected call reads as engaged");
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
        !!engagedRow && !engagedRow.slice(1).some((x) => String(x).includes("Not measured")),
        'Block A "Engaged calls" shows a count in every period, never "Not measured yet"',
    );
    // Block A (company) and Block C (per caller) count one predicate: the MTD
    // figures agree once calls by nobody on Block C's list are added back.
    const mtd = await one(sql`
        SELECT COUNT(*) FILTER (WHERE ${engagedCall()}) AS company
          FROM lead_touchpoints t
         WHERE (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN date_trunc('month', ${covered}::date)::date AND ${covered}::date`);
    const aMtd = engagedRow ? Number(String(engagedRow[3]).replace(/,/g, "")) : NaN;
    check(aMtd === num(mtd.company), "Block A Engaged calls MTD = connected human calls MTD", `${aMtd} vs ${num(mtd.company)}`);
    // Block C is one group of metric rows per rep: [metric, yesterday, MTD, MTD target, % of target].
    const cEngaged = (cBlock?.rows ?? []).filter((r) => r[0] === "Engaged calls");
    const cSum = cEngaged.reduce((n, r) => n + (Number(String(r[2]).replace(/,/g, "")) || 0), 0);
    check(cSum <= aMtd, "Block C per-caller Engaged MTD sums to no more than Block A", `${cSum} of ${aMtd}`);
    check(
        !!cBlock && cEngaged.length > 0 && cEngaged.every((r) => !r.some((x) => String(x).includes("Not measured"))),
        'Block C has an "Engaged calls" row per rep, as a count',
        `${cEngaged.length} reps`,
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
