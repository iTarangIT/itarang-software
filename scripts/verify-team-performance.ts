// Read-only check of Sales Head › Team performance against the numbers it must agree with.
//   node --import tsx --env-file=.env.local scripts/verify-team-performance.ts [from] [to]
//
// 1. team totals = Σ people
// 2. each person's visits / quotes / converted / hot = the Sales dashboard's per_spoc block
// 3. dealers onboarded ≤ the funnel's approved onboardings in the range (credit can miss an app with no salesperson)
// 4. a person whose scorecard shows a target has state accepted / awaiting / partly / correction; "not pushed" has none in force
// 5. the report sheets are rectangular
import { buildTeamPerformance } from "@/lib/dashboard/teamPerformance";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { peopleSheet, teamPerformanceSheets } from "@/lib/dashboard/teamPerformanceReport";
import { sumCounts, monthRange, previousMonth, TEAM_COUNT_DRILL, TARGET_METRIC_DRILL } from "@/lib/dashboard/teamPerformanceRules";
import { DRILL_KINDS, salesDrillRows, type DrillKind } from "@/lib/dashboard/salesDrill";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

let fails = 0;
const check = (ok: boolean, msg: string) => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`);
    if (!ok) fails++;
};

async function run(from: string, to: string) {
    console.log(`\n── ${from} → ${to}`);
    const tp = await buildTeamPerformance({ from, to, team: "all" });
    const dash = await buildSalesDashboard({ from, to, granularity: "month" });
    console.log(`  people ${tp.people.length} · visits ${tp.team.visits} · hot/warm/cold ${tp.team.hot}/${tp.team.warm}/${tp.team.cold} · quotes ${tp.team.quotes_issued} · onboarded ${tp.team.dealers_onboarded} · converted ${tp.team.converted} · lost ${tp.team.lost} · conv ${tp.team.conversion_pct ?? "—"}%`);
    console.log(`  target states ${JSON.stringify(tp.target_states)} · team targets ${tp.team_targets.map((r) => `${r.metric} ${r.actual}/${r.mtd_target}`).join(", ") || "none"}`);

    const s = sumCounts(tp.people);
    check(
        (Object.keys(s) as (keyof typeof s)[]).every((k) => Math.abs(s[k] - tp.team[k]) < 0.01),
        "team totals = Σ people",
    );

    const blocks = new Map((dash.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    let mismatch = 0;
    for (const p of tp.people) {
        const b = blocks.get(p.user_id);
        const hot = b?.interest.rows.find((r) => r.interest_level === "hot")?.total ?? 0;
        if (
            (b?.totals.visits ?? 0) !== p.visits ||
            (b?.outcome.quotes_issued ?? 0) !== p.quotes_issued ||
            (b?.totals.converted ?? 0) !== p.converted ||
            hot !== p.hot
        ) {
            mismatch++;
            console.log(`    mismatch ${p.name}`);
        }
    }
    check(mismatch === 0, "each person's visits / quotes / converted / hot = Sales dashboard per_spoc");

    const appr = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM dealer_onboarding_applications app
         WHERE app.approved_at IS NOT NULL
           AND ((app.approved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ n: number }>;
    check(tp.team.dealers_onboarded <= appr[0].n, `dealers onboarded credited to the team (${tp.team.dealers_onboarded}) ≤ approved in range (${appr[0].n})`);

    const bad = tp.people.filter(
        (p) =>
            (p.target_status.in_force > 0 && ["none", "with_sales_head"].includes(p.target_status.state)) ||
            (p.target_status.in_force === 0 && !["none", "with_sales_head"].includes(p.target_status.state)),
    );
    check(bad.length === 0, "target state agrees with targets in force");
    for (const p of tp.people.filter((x) => x.target_status.state !== "accepted")) {
        console.log(`    ${String(p.name).padEnd(22)} ${p.target_status.label.padEnd(18)} ${p.target_status.detail}`);
    }

    // 6. every clickable number opens exactly that many rows (team-wide and per person)
    const ids = tp.people.map((p) => p.user_id);
    const kinds = Object.entries(TEAM_COUNT_DRILL).filter(([k]) => k !== "revenue") as Array<[keyof typeof TEAM_COUNT_DRILL, string]>;
    check([...Object.values(TEAM_COUNT_DRILL), ...Object.values(TARGET_METRIC_DRILL)].every((k) => (DRILL_KINDS as readonly string[]).includes(k)), "every drill kind exists");
    let badDrill = 0;
    for (const [key, kind] of kinds) {
        const rows = await salesDrillRows(kind as DrillKind, { from, to }, { persons: ids.length ? ids : ["__nobody__"], limit: 20000 });
        if (rows.length !== tp.team[key]) {
            badDrill++;
            console.log(`    team ${key}: number ${tp.team[key]} vs rows ${rows.length}`);
        }
        for (const p of tp.people.filter((x) => Number(x[key]) > 0)) {
            const pr = await salesDrillRows(kind as DrillKind, { from, to }, { persons: [p.user_id], limit: 20000 });
            if (pr.length !== Number(p[key])) {
                badDrill++;
                console.log(`    ${p.name} ${key}: number ${p[key]} vs rows ${pr.length}`);
            }
        }
    }
    check(badDrill === 0, `every team / person number = rows it opens (${kinds.map(([k]) => k).join(", ")})`);
    // 7. target rows: count metrics open as many rows as the actual
    let badTarget = 0;
    for (const r of tp.team_targets.filter((x) => x.kind === "count" && x.actual != null && TARGET_METRIC_DRILL[x.metric] && tp.target_window)) {
        const rows = await salesDrillRows(TARGET_METRIC_DRILL[r.metric] as DrillKind, tp.target_window!, { persons: r.user_ids, limit: 20000 });
        // Batteries are a quantity over lines, not a row count — skipped here.
        if (r.metric !== "batteries_sold" && rows.length !== r.actual) {
            badTarget++;
            console.log(`    target ${r.metric}: actual ${r.actual} vs rows ${rows.length}`);
        }
    }
    check(badTarget === 0, "target-row actuals (count metrics) = rows they open");

    // 8. a manager's team = the manager + direct reports, and its totals are theirs
    for (const m of tp.managers) {
        const mt = await buildTeamPerformance({ from, to, team: "all", manager_id: m.id });
        const ok = mt.people.every((p) => p.user_id === m.id || tp.people.find((x) => x.user_id === p.user_id)?.manager === m.name);
        check(ok && mt.people.length <= m.members + 1, `${m.name}'s team: ${mt.people.map((p) => p.name).join(", ")} (visits ${mt.team.visits}, quotes ${mt.team.quotes_issued})`);
    }

    const sheets = teamPerformanceSheets(tp);
    check(sheets.every((sh) => sh.name === "Summary" || sh.rows.every((r) => r.length === sh.headers.length)), "report sheets are rectangular");
    check(peopleSheet(tp).rows.length === tp.people.length + 1, "People sheet = people + team total");
}

async function main() {
    const today = ((await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)) as unknown as Array<{ d: string }>)[0].d;
    if (process.argv[2] && process.argv[3]) {
        await run(process.argv[2], process.argv[3]);
    } else {
        const cur = monthRange(today.slice(0, 7), today);
        const last = monthRange(previousMonth(today), today);
        await run(cur.from, cur.to);
        await run(last.from, last.to);
    }
    console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
    process.exit(fails ? 1 : 0);
}
void main();
