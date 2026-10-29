// ID 155 (22 Oct) / ID 198 (29 Oct) — each manager's dated "Team subtotal"
// group: each member counted only for the days he reported to the manager this
// month (dated reporting lines, leavers too), as the Performance page's Team
// total does. Moved out of the management Sales email's collect so the "My
// team" email adds up the same way.
//
// A failure leaves that manager on today's members (repBlockTableRows'
// default) and is logged.

import { db } from "@/lib/db";
import {
    buildRepBlocks,
    datedTeamGroup,
    loadRepExtras,
    outsideManagerBlock,
    type RepBlock,
    type TeamGroups,
    type TeamOf,
    type UserTargets,
} from "./salesDailyBlocks";

/** Managers of members in `blocks` who are not in `blocks` themselves. */
export function outsideManagersOf(blocks: readonly RepBlock[], teamOf: TeamOf): string[] {
    const ids = new Set(blocks.map((b) => b.id));
    return [...new Set(blocks.map((b) => teamOf.get(b.id)).filter((m): m is string => !!m && !ids.has(m)))];
}

export async function datedTeamGroupsFor(input: {
    role: "asm" | "inside_sales_rep";
    blocks: RepBlock[];
    teamOf: TeamOf;
    /** Managers outside the block's role, id → name (ID 155, 24 Oct). */
    outsideNames: ReadonlyMap<string, string>;
    periods: { mtd: { from: string; to: string }; yesterday: { from: string } };
    userTargets: UserTargets;
    /** Only these managers (the My team email builds one manager's group). */
    only?: readonly string[];
    logTag: string;
}): Promise<TeamGroups> {
    const { role, blocks, teamOf, outsideNames, periods, userTargets } = input;
    const out = new Map<string, RepBlock[]>();
    const full = new Map(blocks.map((b) => [b.id, b]));
    const outside = outsideManagersOf(blocks, teamOf);
    const managers = [...new Set(teamOf.values())]
        .filter((m) => full.has(m) || (outsideNames.has(m) && outside.includes(m)))
        .filter((m) => !input.only || input.only.includes(m));
    if (managers.length === 0) return out;
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { teamStints } = await import("@/lib/admin/teamPerformance");
    const { teamWindows } = await import("@/lib/users/teamWindows");
    const { from, to } = periods.mtd;
    for (const m of managers) {
        try {
            const members = [...teamOf].filter(([, mg]) => mg === m).map(([id]) => id);
            const stints =
                (await teamStints(m, from, to)) ?? members.map((id) => ({ user_id: id, effective_from: from, effective_to: null }));
            const windows = teamWindows(m, stints, from, to);
            const partial = new Map<string, Map<string, RepBlock>>();
            for (const w of windows) {
                if (w.from === from && w.to === to) continue;
                const [dash, ex] = await Promise.all([
                    buildSalesDashboard({ from: w.from, to: w.to, granularity: "day", spoc_ids: w.ids }),
                    loadRepExtras(db as never, { from: w.from, to: w.to }),
                ]);
                const wb = buildRepBlocks(role, { per_spoc: [] }, dash, { y: ex, mtd: ex }, userTargets);
                partial.set(`${w.from}|${w.to}`, new Map(wb.map((b) => [b.id, b])));
            }
            const manager = full.get(m) ?? outsideManagerBlock(m, outsideNames.get(m)!, blocks);
            out.set(m, datedTeamGroup({ manager, windows, mtd: periods.mtd, yesterday: periods.yesterday.from, full, partial }));
        } catch (err) {
            console.error(`[${input.logTag}] dated team subtotal for ${m} failed; using today's team:`, err);
        }
    }
    return out;
}
