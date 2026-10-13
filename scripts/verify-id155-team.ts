/**
 * Read-only check of tracker IDs 155 / 156 (a manager sees their team's leads,
 * may reassign within the team, may NOT edit; Performance "Team total").
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id155-team.ts
 *
 * Imports the real rules and query builders — nothing is restated. Runs only
 * SELECTs (queue counts, the sales-dashboard builder, the team lookup). Writes
 * nothing, reassigns nothing.
 *
 * When no reporting line is set on this database yet, it says so and SIMULATES
 * a team from real users (in memory only) to prove the scoping SQL against
 * real rows: a manager's own tab must equal the sum of each member's own tab.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { canEditLead } from "@/lib/leads/access";
import { countQueueRows } from "@/lib/inside-sales/queryBuilder";
import { countAsmQueueRows } from "@/lib/asm/queryBuilder";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { getTeamMemberIds, leadVisibleTo } from "@/lib/users/team";
import { hasReportingHistoryTable, hasReportsToColumn } from "@/lib/users/reportingLines";
import {
    TEAM_TOTAL_PERSON,
    checkTeamReassign,
    ownerInScope,
    pickPerformanceScope,
} from "@/lib/users/teamRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

type U = { id: string; name: string | null; role: string };

/** Managers on this DB: manager id → direct reports (open line). */
async function realTeams(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    let pairs: Array<{ manager_id: string; user_id: string }> = [];
    if (await hasReportingHistoryTable()) {
        pairs = rowsOf(
            await db.execute(sql`
                SELECT manager_id::text AS manager_id, user_id::text AS user_id
                  FROM user_reporting_lines
                 WHERE effective_to IS NULL AND manager_id IS NOT NULL
            `),
        );
    } else if (await hasReportsToColumn()) {
        pairs = rowsOf(
            await db.execute(sql`
                SELECT to_jsonb(u) ->> 'reports_to' AS manager_id, u.id::text AS user_id
                  FROM users u WHERE to_jsonb(u) ->> 'reports_to' IS NOT NULL
            `),
        );
    }
    for (const p of pairs) out.set(p.manager_id, [...(out.get(p.manager_id) ?? []), p.user_id]);
    return out;
}

/** The scoping SQL against real rows: a manager's own tabs = Σ each member's. */
async function checkQueueScope(label: string, manager: U, team: string[]) {
    const people = [manager.id, ...team];
    for (const tab of ["my_open", "follow_ups", "my_closed"] as const) {
        const together = await countQueueRows({ tab, userId: manager.id, teamMemberIds: team });
        let sum = 0;
        for (const p of people) sum += await countQueueRows({ tab, userId: p });
        check(`${label} ISR ${tab}: manager+team = Σ members`, together === sum, `${together} vs ${sum}`);
    }
    for (const tab of ["my_visits", "my_closed"] as const) {
        const together = await countAsmQueueRows({ tab, asmId: manager.id, teamMemberIds: team });
        let sum = 0;
        for (const p of people) sum += await countAsmQueueRows({ tab, asmId: p });
        check(`${label} ASM ${tab}: manager+team = Σ members`, together === sum, `${together} vs ${sum}`);
    }
    // A team member's own tab is untouched (no team passed = old SQL).
    if (team[0]) {
        const alone = await countQueueRows({ tab: "my_open", userId: team[0] });
        const asIfNoTeam = await countQueueRows({ tab: "my_open", userId: team[0], teamMemberIds: [] });
        check(`${label} team member sees only their own`, alone === asIfNoTeam, `${alone}`);
    }
}

/** ID 156: Team total = the same builder over the group; additive columns sum. */
async function checkTeamTotal(label: string, manager: U, team: string[]) {
    const window = { from: null, to: null, granularity: "day" as const };
    const scope = pickPerformanceScope(manager.id, TEAM_TOTAL_PERSON, team);
    check(`${label} ?person=team → the group`, scope.spoc_ids?.length === team.length + 1);
    const group = await buildSalesDashboard({ ...window, ...scope });
    let visits = 0;
    let calls = 0;
    let converted = 0;
    for (const p of [manager.id, ...team]) {
        const one = await buildSalesDashboard({ ...window, spoc_id: p });
        visits += one.totals.visits;
        calls += one.totals.calls;
        converted += one.totals.converted;
    }
    check(`${label} Team total visits = Σ per person`, group.totals.visits === visits, `${group.totals.visits} vs ${visits}`);
    check(`${label} Team total calls = Σ per person`, group.totals.calls === calls, `${group.totals.calls} vs ${calls}`);
    check(
        `${label} Team total converted = Σ per person`,
        group.totals.converted === converted,
        `${group.totals.converted} vs ${converted}`,
    );
    check(`${label} Team total has no per-rep split`, group.per_spoc === null);
}

/** Read / reassign yes, edit no — on one real lead a team member owns. */
async function checkLeadRights(label: string, manager: U, team: string[], live: boolean) {
    const [lead] = rowsOf<{ id: string; current_owner_id: string; asm_id: string | null }>(
        await db.execute(sql`
            SELECT id, current_owner_id::text AS current_owner_id, asm_id::text AS asm_id
              FROM dealer_leads
             WHERE current_owner_id::text IN (${sql.join(team.map((t) => sql`${t}`), sql`, `)})
             LIMIT 1
        `),
    );
    if (!lead) {
        console.log(`(${label}: no team member owns a lead — read/edit check skipped)`);
        return;
    }
    check(`${label} manager reads a team lead (rule)`, ownerInScope(lead.current_owner_id, manager.id, team));
    if (live) check(`${label} manager reads a team lead (db)`, await leadVisibleTo(lead.id, manager.id));
    check(
        `${label} manager may NOT edit a team lead`,
        lead.asm_id === manager.id ||
            !canEditLead({ role: manager.role, userId: manager.id, currentOwnerId: lead.current_owner_id, asmId: lead.asm_id }),
    );
    const other = team.find((t) => t !== lead.current_owner_id) ?? manager.id;
    check(
        `${label} manager may reassign it within the team`,
        checkTeamReassign({ actorId: manager.id, currentOwnerId: lead.current_owner_id, targetUserId: other, teamMemberIds: team }).ok,
    );
    check(
        `${label} a team member may not see a colleague's lead`,
        !ownerInScope(lead.current_owner_id, other === manager.id ? "nobody" : other, []),
    );
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}\n`);

    const teams = await realTeams();
    const names = new Map(
        rowsOf<U>(await db.execute(sql`SELECT id::text AS id, name, role FROM users`)).map((u) => [u.id, u]),
    );

    if (teams.size === 0) {
        console.log("no reporting lines set yet — simulating a team in memory (nothing is written)\n");
        const reps = rowsOf<U>(
            await db.execute(sql`
                SELECT u.id::text AS id, u.name, u.role
                  FROM users u
                 WHERE u.role IN ('asm', 'inside_sales_rep') AND u.is_active IS NOT FALSE
                 ORDER BY (SELECT COUNT(*) FROM dealer_leads dl WHERE dl.current_owner_id::text = u.id::text) DESC
                 LIMIT 3
            `),
        );
        if (reps.length < 2) {
            console.log("fewer than two active reps — nothing to simulate");
        } else {
            const [manager, ...team] = reps;
            const teamIds = team.map((t) => t.id);
            console.log(`simulated: ${manager.name} (${manager.role}) manages ${team.map((t) => t.name).join(", ")}\n`);
            // The live lookup must agree that nobody has a team yet.
            check("getTeamMemberIds is empty with no lines set", (await getTeamMemberIds(manager.id)).length === 0);
            await checkQueueScope("[sim]", manager, teamIds);
            await checkTeamTotal("[sim]", manager, teamIds);
            await checkLeadRights("[sim]", manager, teamIds, false);
        }
    } else {
        console.log(`${teams.size} manager(s) with direct reports\n`);
        for (const [managerId, team] of [...teams].slice(0, 3)) {
            const manager = names.get(managerId) ?? { id: managerId, name: managerId, role: "?" };
            console.log(`\n${manager.name} (${manager.role}) → ${team.map((t) => names.get(t)?.name ?? t).join(", ")}`);
            const live = await getTeamMemberIds(managerId);
            check("getTeamMemberIds matches the open lines", live.slice().sort().join() === team.slice().sort().join());
            await checkQueueScope("", manager, live);
            await checkTeamTotal("", manager, live);
            await checkLeadRights("", manager, live, true);
        }
    }

    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
