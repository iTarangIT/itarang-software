/**
 * Sales Head › Team performance — the data half (26 Nov task). Pure rules and
 * types are in ./teamPerformanceRules.ts.
 *
 * SOURCES (nothing here re-counts what another module owns):
 *   visits, calls, Hot/Warm/Cold, quotes, converted, KYC, revenue
 *       buildSalesDashboard (per_spoc) — the numbers on the scorecard below.
 *   dealers onboarded
 *       dealer_onboarding_applications.approved_at in range (IST, the column is
 *       naive UTC — as funnelCounts.ts), credited to the salesperson on the
 *       application (E-329), else whoever closed / owns the originating lead,
 *       else the sponsoring ASM, else the onboarding owner.
 *   lost
 *       dealer_leads closed Lost in range (closed_at, IST), credited to the
 *       closing owner — the same basis as `converted`.
 *   targets
 *       listTargets for the month of the range's END date, viewer "manager"
 *       (never a CEO draft) — the same rows the scorecard reads.
 *
 * Everyone on the sales team is listed — an active ASM / sales manager / ISR
 * with no activity in the range still gets a row (all zeros) so a missing
 * target is visible, not hidden behind "no activity".
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import type { SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
import { leadScopeSql } from "@/lib/leads/leadScopeSql";
import { listTargets, workingDayContext } from "@/lib/targets/service";
import {
    conversionPct,
    inSegment,
    personTargetStatus,
    rollupTeamTargets,
    segmentOf,
    sumCounts,
    ZERO_COUNTS,
    type PerfCounts,
    type PersonTargetStatus,
    type TargetLike,
    type TeamSegment,
    type TeamTargetRow,
} from "./teamPerformanceRules";

export interface TeamPerformanceInput {
    from?: string | null;
    to?: string | null;
    state?: string | null;
    city?: string | null;
    business_type?: string | null;
    team: TeamSegment;
}

export interface TeamPersonTarget {
    metric: string;
    label: string;
    kind: "count" | "money" | "per_day";
    status: string;
    final_target: number;
    mtd_target: number;
    actual: number | null;
    pct: number | null;
    pushed_at: string | null;
    accepted_at: string | null;
}

export interface TeamPerson extends PerfCounts {
    user_id: string;
    name: string | null;
    role: string | null;
    segment: "field" | "inside" | "other";
    manager: string | null;
    conversion_pct: number | null;
    target_status: PersonTargetStatus;
    targets: TeamPersonTarget[];
}

export interface TeamPerformance {
    filters: { from: string; to: string; state: string | null; city: string | null; business_type: string | null; team: TeamSegment };
    as_of: string;
    /** YYYY-MM the targets are read for (the range's end date). */
    target_month: string;
    working_days: { total: number; elapsed: number };
    team: PerfCounts & { conversion_pct: number | null; people: number };
    team_targets: TeamTargetRow[];
    /** People per target state — the "why don't I see targets" summary. */
    target_states: Record<PersonTargetStatus["state"], number>;
    people: TeamPerson[];
}

const SALES_ROLES = ["asm", "sales_manager", "inside_sales_rep"];

function countsOf(b: SalesSpocBlock | undefined): PerfCounts {
    if (!b) return { ...ZERO_COUNTS };
    const lvl = (l: string) => b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
    return {
        visits: b.totals.visits,
        new_visits: b.totals.new_visits,
        unique_visits: b.totals.unique_visits,
        calls: b.totals.calls,
        hot: lvl("hot"),
        warm: lvl("warm"),
        cold: lvl("cold"),
        new_hot: b.totals.new_hot,
        quotes_issued: b.outcome.quotes_issued,
        quote_revisions: b.outcome.quote_revisions,
        dealers_onboarded: 0,
        converted: b.totals.converted,
        lost: 0,
        kyc_submitted: b.outcome.kyc_submitted,
        revenue: b.outcome.revenue,
    };
}

/** Onboardings approved and leads lost in the range, per credited person. */
async function onboardedAndLost(f: { from: string; to: string; state?: string | null; city?: string | null; business_type?: string | null }) {
    const geo = (col: ReturnType<typeof sql>, v: string | null | undefined) => (v ? sql` AND lower(trim(${col})) = lower(trim(${v}))` : sql``);
    // business_type lives on the lead; an onboarding without a lead is left out
    // only when that filter is set.
    const rows = (await db.execute(sql`
        WITH onb AS (
            SELECT COALESCE(
                       NULLIF(to_jsonb(app) ->> 'salesperson_user_id', ''),
                       dl.closing_owner_id, dl.current_owner_id,
                       NULLIF(app.sponsoring_asm_id, ''), NULLIF(app.owner_id, '')
                   ) AS u
              FROM dealer_onboarding_applications app
              LEFT JOIN dealer_leads dl ON dl.id = app.originating_dealer_lead_id
             WHERE app.approved_at IS NOT NULL
               AND ((app.approved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date
               ${geo(sql`app.state`, f.state)} ${geo(sql`app.city`, f.city)}
               ${f.business_type ? leadScopeSql({ business_type: f.business_type }) : sql``}
        ),
        lost AS (
            SELECT COALESCE(dl.closing_owner_id, dl.current_owner_id) AS u
              FROM dealer_leads dl
             WHERE dl.lead_status = 'Lost'
               AND dl.closed_at IS NOT NULL
               AND dl.deleted_at IS NULL
               AND (dl.closed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date
               ${leadScopeSql(f)}
        )
        SELECT u, 'onb' AS k, COUNT(*)::text AS n FROM onb WHERE u IS NOT NULL GROUP BY u
        UNION ALL
        SELECT u, 'lost', COUNT(*)::text FROM lost WHERE u IS NOT NULL GROUP BY u
    `)) as unknown as Array<{ u: string; k: string; n: string }>;
    const out = new Map<string, { onb: number; lost: number }>();
    for (const r of rows) {
        const x = out.get(r.u) ?? { onb: 0, lost: 0 };
        if (r.k === "onb") x.onb += Number(r.n);
        else x.lost += Number(r.n);
        out.set(r.u, x);
    }
    return out;
}

async function salesTeam(): Promise<Array<{ id: string; name: string | null; role: string; manager: string | null }>> {
    return (await db.execute(sql`
        SELECT u.id::text AS id, u.name, LOWER(u.role) AS role, m.name AS manager
          FROM users u
          LEFT JOIN users m ON m.id::text = to_jsonb(u) ->> 'reports_to'
         WHERE u.is_active = TRUE AND LOWER(u.role) IN (${sql.join(SALES_ROLES.map((r) => sql`${r}`), sql`, `)})
    `)) as unknown as Array<{ id: string; name: string | null; role: string; manager: string | null }>;
}

export async function buildTeamPerformance(input: TeamPerformanceInput): Promise<TeamPerformance> {
    const dash = await buildSalesDashboard({
        from: input.from ?? null,
        to: input.to ?? null,
        state: input.state ?? null,
        city: input.city ?? null,
        business_type: input.business_type ?? null,
        granularity: "month",
    });
    const { from, to } = dash.filters;
    const month = to.slice(0, 7);
    const [extras, team, targetRows, ctx] = await Promise.all([
        onboardedAndLost({ from, to, state: input.state, city: input.city, business_type: input.business_type }),
        salesTeam(),
        listTargets({ month, viewer: "manager" }),
        workingDayContext(month),
    ]);

    const blocks = new Map((dash.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const teamById = new Map(team.map((t) => [t.id, t]));
    // Everyone with activity, plus every active sales person (zeros), plus anyone with a target.
    const ids = new Set<string>([...blocks.keys(), ...team.map((t) => t.id), ...targetRows.map((t) => t.user_id)]);

    const people: TeamPerson[] = [];
    for (const id of ids) {
        const b = blocks.get(id);
        const t = teamById.get(id);
        const role = (t?.role ?? b?.role ?? targetRows.find((r) => r.user_id === id)?.user_role ?? null)?.toLowerCase() ?? null;
        // Only the sales team: an admin / CEO / partner row with activity stays on the scorecard, not here.
        if (segmentOf(role) === "other") continue;
        if (!inSegment(role, input.team)) continue;
        if (b?.is_active === false && !t) continue;
        const c = countsOf(b);
        const ex = extras.get(id);
        c.dealers_onboarded = ex?.onb ?? 0;
        c.lost = ex?.lost ?? 0;
        const mine = targetRows.filter((r) => r.user_id === id) as unknown as TargetLike[];
        people.push({
            ...c,
            user_id: id,
            name: t?.name ?? b?.name ?? targetRows.find((r) => r.user_id === id)?.user_name ?? null,
            role,
            segment: segmentOf(role),
            manager: t?.manager ?? null,
            conversion_pct: conversionPct(c.converted, c.lost),
            target_status: personTargetStatus(mine, month),
            targets: targetRows
                .filter((r) => r.user_id === id)
                .map((r) => ({
                    metric: r.metric,
                    label: r.metric_label,
                    kind: r.kind,
                    status: r.status,
                    final_target: r.final_target,
                    mtd_target: r.progress.mtd_target,
                    actual: r.progress.actual,
                    pct: r.progress.pct_of_mtd == null ? null : Math.round(r.progress.pct_of_mtd),
                    pushed_at: r.pushed_at,
                    accepted_at: r.accepted_at,
                })),
        });
    }
    people.sort((a, b) => a.segment.localeCompare(b.segment) || (a.name ?? "").localeCompare(b.name ?? ""));

    const total = sumCounts(people);
    const states = { none: 0, with_sales_head: 0, awaiting_acceptance: 0, correction_asked: 0, accepted: 0, partly_accepted: 0 };
    for (const p of people) states[p.target_status.state] += 1;

    return {
        filters: {
            from,
            to,
            state: input.state ?? null,
            city: input.city ?? null,
            business_type: input.business_type ?? null,
            team: input.team,
        },
        as_of: dash.as_of_date,
        target_month: month,
        working_days: { total: ctx.working_days_total, elapsed: ctx.working_days_elapsed },
        team: { ...total, conversion_pct: conversionPct(total.converted, total.lost), people: people.length },
        team_targets: rollupTeamTargets(targetRows as unknown as TargetLike[], new Set(people.map((p) => p.user_id))),
        target_states: states,
        people,
    };
}
