// Read-only check of ID 156: a manager's Team total = the manager's own
// numbers + each member's for the days they were in the team — the same
// numbers the Sales Head's per-person table shows for those people and days.
//
//   node --import tsx --env-file=.env.local scripts/verify-id156-team-numbers.ts [from] [to]
//
// 1. For every manager with a reporting line in the range: the Performance
//    page's Team total (buildPerformanceDashboard) = Σ over the team windows of
//    each person's row on the per-person table (buildSalesDashboard per_spoc).
// 2. Always (even with no lines set yet): a simulated team — the two busiest
//    reps, the second joining half-way — merged by mergeWindowParts equals the
//    per-person rows for those days, so the merge is checked on real data.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildSalesDashboard, type SalesTotals } from "@/lib/admin/salesDashboard";
import { buildPerformanceDashboard, teamStints } from "@/lib/admin/teamPerformance";
import { daysInclusive, mergeWindowParts, teamWindows, type TeamWindow } from "@/lib/users/teamWindows";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

const KEYS: Array<keyof SalesTotals> = ["visits", "unique_visits", "new_visits", "calls", "converted"];

/** Σ of each window's people as rows on the per-person table for that window. */
async function perPersonSum(windows: TeamWindow[]) {
    const sum = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<keyof SalesTotals, number>;
    let revenue = 0;
    for (const w of windows) {
        const d = await buildSalesDashboard({ from: w.from, to: w.to, granularity: "day" });
        for (const p of d.per_spoc ?? []) {
            if (!w.ids.includes(p.spoc_id)) continue;
            for (const k of KEYS) sum[k] += p.totals[k];
            revenue += p.outcome.revenue;
        }
    }
    return { sum, revenue };
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const [from = `${today.slice(0, 7)}-01`, to = today] = process.argv.slice(2);

    // 1 — real managers
    const managers = (await db.execute(sql`
        SELECT DISTINCT l.manager_id::text AS id, u.name
          FROM user_reporting_lines l JOIN users u ON u.id = l.manager_id
         WHERE l.effective_from <= ${to}::date AND (l.effective_to IS NULL OR l.effective_to > ${from}::date)
    `).catch(() => [])) as unknown as Array<{ id: string; name: string | null }>;
    if (managers.length === 0) console.log("      no reporting lines in the range yet — set one in Admin › Settings › Reporting lines");
    for (const m of managers) {
        const team = await buildPerformanceDashboard(m.id, "team", { from, to, granularity: "day" });
        const windows = teamWindows(m.id, (await teamStints(m.id, from, to)) ?? [], from, to);
        const { sum, revenue } = await perPersonSum(windows);
        const off = KEYS.filter((k) => team.totals[k] !== sum[k]);
        check(`${m.name}: Team total = Σ per-person rows (${KEYS.join(", ")})`, off.length === 0, off.map((k) => [k, team.totals[k], sum[k]]));
        check(`${m.name}: team revenue ${team.outcome.revenue} = ${revenue}`, Math.abs(team.outcome.revenue - revenue) < 1);
        console.log(`      ${m.name}: ${team.team?.members.map((x) => `${x.name} ${x.from}→${x.to}`).join(", ") || "no members in range"}`);
    }

    // 2 — simulated team on real data
    const all = await buildSalesDashboard({ from, to, granularity: "day" });
    const busiest = [...(all.per_spoc ?? [])].sort((a, b) => b.totals.visits + b.totals.calls - (a.totals.visits + a.totals.calls)).slice(0, 2);
    if (busiest.length < 2) {
        console.log("SKIP  simulated team — fewer than two reps with activity in the range");
    } else {
        const [mgr, mem] = busiest;
        const half = new Date(Date.parse(`${from}T00:00:00Z`) + Math.floor(daysInclusive(from, to) / 2) * 86_400_000).toISOString().slice(0, 10);
        const windows = teamWindows(mgr.spoc_id, [{ user_id: mem.spoc_id, effective_from: half, effective_to: null }], from, to);
        const parts = await Promise.all(
            windows.map(async (w) => {
                const d = await buildSalesDashboard({ from: w.from, to: w.to, spoc_ids: w.ids, granularity: "day" });
                return { days: daysInclusive(w.from, w.to), series: d.series, averages: d.averages, totals: d.totals, outcome: d.outcome };
            }),
        );
        const merged = mergeWindowParts(parts, daysInclusive(from, to));
        const { sum } = await perPersonSum(windows);
        const off = KEYS.filter((k) => k !== "unique_visits" && merged.totals[k] !== sum[k]);
        check(
            `simulated: ${mgr.name} + ${mem.name} from ${half} — merged totals = Σ per-person rows`,
            off.length === 0,
            off.map((k) => [k, merged.totals[k], sum[k]]),
        );
        const seriesVisits = merged.series.reduce((a, r) => a + r.visits, 0);
        check(`simulated: series visits ${seriesVisits} = total visits ${merged.totals.visits}`, seriesVisits === merged.totals.visits);
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
