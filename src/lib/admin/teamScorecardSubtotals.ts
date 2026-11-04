/**
 * ID 155 (report place: Sales dashboard › "Team scorecard against target").
 *
 * One "Team subtotal" row per manager, by the SAME rule as Performance › Team
 * total (teamPerformance.ts): the manager's own numbers plus each member's for
 * the days that member was in the team (E-338 dated reporting lines, effective_to
 * exclusive). Without line history the team is today's members over the whole
 * range. Field figures come from buildPerformanceDashboard; the Inside-sales
 * figures (isrScorecard.ts) are summed window by window the same way.
 */
import { buildPerformanceDashboard, teamStints } from "@/lib/admin/teamPerformance";
import { buildIsrScorecard, type IsrScore } from "@/lib/admin/isrScorecard";
import type { SalesDashboard, SalesDashboardInput } from "@/lib/admin/salesDashboard";
import { getTeamMemberIds } from "@/lib/users/team";
import { teamWindows } from "@/lib/users/teamWindows";

export type TeamIsrTotals = Pick<IsrScore, "calls" | "engaged" | "hot_to_field" | "hot_visited" | "quotes_delivered" | "won">;

export type TeamScorecardSubtotal = {
    manager_id: string;
    totals: SalesDashboard["totals"];
    outcome: SalesDashboard["outcome"];
    averages: SalesDashboard["averages"];
    isr: TeamIsrTotals | null;
};

const ZERO_ISR: TeamIsrTotals = { calls: 0, engaged: 0, hot_to_field: 0, hot_visited: 0, quotes_delivered: 0, won: 0 };

export async function teamScorecardSubtotals(
    managerIds: readonly string[],
    input: Omit<SalesDashboardInput, "spoc_id" | "spoc_ids">,
    opts: { inside: boolean },
): Promise<Record<string, TeamScorecardSubtotal>> {
    const out: Record<string, TeamScorecardSubtotal> = {};
    // One ISR read per distinct window, shared across managers.
    const isrCache = new Map<string, Promise<Record<string, IsrScore>>>();
    const isrFor = (from: string, to: string) => {
        const k = `${from}|${to}`;
        if (!isrCache.has(k)) isrCache.set(k, buildIsrScorecard({ from, to, state: input.state ?? null }));
        return isrCache.get(k)!;
    };

    await Promise.all(
        managerIds.map(async (managerId) => {
            const dash = await buildPerformanceDashboard(managerId, "team", input);
            // A person with no team: pickPerformanceScope gives their own numbers only — no subtotal.
            if (!dash.team) return;
            let isr: TeamIsrTotals | null = null;
            if (opts.inside) {
                const { from, to } = dash.filters;
                const members = await getTeamMemberIds(managerId);
                const stints =
                    (await teamStints(managerId, from, to)) ??
                    members.map((id) => ({ user_id: id, effective_from: from, effective_to: null }));
                isr = { ...ZERO_ISR };
                for (const w of teamWindows(managerId, stints, from, to)) {
                    const scores = await isrFor(w.from, w.to);
                    for (const id of w.ids) {
                        const s = scores[id];
                        if (!s) continue;
                        for (const k of Object.keys(ZERO_ISR) as Array<keyof TeamIsrTotals>) isr[k] += Number(s[k] ?? 0);
                    }
                }
            }
            out[managerId] = { manager_id: managerId, totals: dash.totals, outcome: dash.outcome, averages: dash.averages, isr };
        }),
    );
    return out;
}
