/**
 * ID 156 — a rep's own Performance page, with a manager's team.
 *
 * The page's numbers come from the one sales-dashboard builder, so a person's
 * numbers here equal their row on the Sales Head's per-person table. A manager
 * (anyone with direct reports, ID 155) may pick a member (`?person=<id>`) or
 * the Team total (`?person=team`): the manager's own numbers plus each
 * member's FOR THE DATES THEY WERE IN THE TEAM (E-338 dated reporting lines),
 * summed (./teamWindows.ts). Open-lead sections (snapshot, interest) are "as
 * of now", so they are the current team's.
 *
 * Without E-338 (no line history) the team is today's members over the whole
 * range — the E-335 behaviour.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildSalesDashboard, type SalesDashboard, type SalesDashboardInput } from "@/lib/admin/salesDashboard";
import { hasReportingHistoryTable } from "@/lib/users/reportingLines";
import { getTeamMemberIds } from "@/lib/users/team";
import { pickPerformanceScope } from "@/lib/users/teamRules";
import { daysInclusive, isSingleWindow, mergeWindowParts, teamWindows, type TeamStint } from "@/lib/users/teamWindows";

/** Every reporting line to `managerId` overlapping [from, to] (inclusive days); null without E-338. */
export async function teamStints(managerId: string, from: string, to: string): Promise<TeamStint[] | null> {
    if (!(await hasReportingHistoryTable())) return null;
    return (await db.execute(sql`
        SELECT l.user_id::text AS user_id,
               to_char(l.effective_from, 'YYYY-MM-DD') AS effective_from,
               to_char(l.effective_to, 'YYYY-MM-DD') AS effective_to
          FROM user_reporting_lines l
         WHERE l.manager_id::text = ${managerId}
           AND l.effective_from <= ${to}::date
           AND (l.effective_to IS NULL OR l.effective_to > ${from}::date)
           AND (l.effective_to IS NULL OR l.effective_to > l.effective_from)
    `)) as unknown as TeamStint[];
}

export type TeamMemberWindow = { id: string; name: string | null; from: string; to: string };

/** The dashboard for the viewer's Performance page, `person` = the `?person=` pick. */
export async function buildPerformanceDashboard(
    userId: string,
    person: string | null,
    input: Omit<SalesDashboardInput, "spoc_id" | "spoc_ids">,
): Promise<SalesDashboard & { team?: { members: TeamMemberWindow[] } }> {
    const members = await getTeamMemberIds(userId);
    const scope = pickPerformanceScope(userId, person, members);
    const current = await buildSalesDashboard({ ...input, ...scope });
    if (!scope.spoc_ids) return current;

    const { from, to } = current.filters;
    const stints = (await teamStints(userId, from, to)) ?? members.map((id) => ({ user_id: id, effective_from: from, effective_to: null }));
    const windows = teamWindows(userId, stints, from, to);
    const names = await userNames(windows.flatMap((w) => w.ids));
    const team = {
        members: windows
            .flatMap((w) => w.ids.filter((id) => id !== userId).map((id) => ({ id, name: names.get(id) ?? null, from: w.from, to: w.to })))
            .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.from.localeCompare(b.from)),
    };

    // Everyone in the team over the whole range: the one IN-list read is the answer.
    const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (isSingleWindow(windows, from, to) && sameIds(windows[0].ids, scope.spoc_ids)) return { ...current, team };

    const parts = await Promise.all(
        windows.map(async (w) => ({ w, d: await buildSalesDashboard({ ...input, from: w.from, to: w.to, spoc_ids: w.ids }) })),
    );
    const merged = mergeWindowParts(
        parts.map(({ w, d }) => ({ days: daysInclusive(w.from, w.to), series: d.series, averages: d.averages, totals: d.totals, outcome: d.outcome })),
        daysInclusive(from, to),
    );
    return { ...current, ...merged, team };
}

async function userNames(ids: string[]): Promise<Map<string, string | null>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const rows = (await db.execute(sql`
        SELECT id::text AS id, COALESCE(name, email) AS name FROM users
         WHERE id::text IN (${sql.join(uniq.map((i) => sql`${i}`), sql`, `)})
    `)) as unknown as Array<{ id: string; name: string | null }>;
    return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * ID 156 — the manager's team against the manager's OWN target (Kartik,
 * 10 Oct: everyone has their own target; the team lead's is not the sum of the
 * members'). Each row is one of the manager's pushed / accepted targets for
 * the month, with the actual = the manager's own + each member's for the days
 * they were in the team, month to date.
 */
export async function teamTargets(managerId: string, month: string) {
    const { actualsFor, listTargets, workingDayContext } = await import("@/lib/targets/service");
    const { monthEnd, progress } = await import("@/lib/targets/rules");
    const monthFirst = `${month.slice(0, 7)}-01`;
    const [rows, ctx, todayRow] = await Promise.all([
        listTargets({ month: monthFirst, userId: managerId }),
        workingDayContext(monthFirst),
        db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`) as unknown as Promise<Array<{ d: string }>>,
    ]);
    const mine = rows.filter((r) => r.status === "pushed" || r.status === "accepted");
    const today = todayRow[0].d;
    const last = monthEnd(monthFirst);
    if (mine.length === 0 || today < monthFirst) return { rows: mine, context: ctx, members: [] as TeamMemberWindow[] };
    const upTo = today > last ? last : today;

    const members = await getTeamMemberIds(managerId);
    const stints = (await teamStints(managerId, monthFirst, upTo)) ?? members.map((id) => ({ user_id: id, effective_from: monthFirst, effective_to: null }));
    const windows = teamWindows(managerId, stints, monthFirst, upTo);
    const lookups = await Promise.all(
        windows.map(async (w) => ({ w, actual: await actualsFor(w.from, w.to, ctx.working_days_elapsed) })),
    );
    const names = await userNames(windows.flatMap((w) => w.ids));
    return {
        rows: mine.map((r) => {
            let sum: number | null = 0;
            for (const { w, actual } of lookups) {
                for (const id of w.ids) {
                    const v = actual(id, r.metric);
                    if (v == null) sum = null;
                    else if (sum != null) sum += v;
                }
            }
            return {
                ...r,
                progress: progress({
                    metric: r.metric,
                    monthly: r.final_target,
                    actual: sum == null ? null : Math.round(sum * 10) / 10,
                    workingDaysTotal: ctx.working_days_total,
                    workingDaysElapsed: ctx.working_days_elapsed,
                }),
            };
        }),
        context: ctx,
        members: windows
            .flatMap((w) => w.ids.filter((id) => id !== managerId).map((id) => ({ id, name: names.get(id) ?? null, from: w.from, to: w.to })))
            .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    };
}
