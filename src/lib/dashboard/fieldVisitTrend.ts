/**
 * "Waiting for a field visit" over time (ID 190, decision 14-15 Oct): for any
 * period, per ASM, with a subtotal for each manager's team and a company
 * total. Every period has these measures:
 *
 *   pending   waiting at the start of the first day
 *   new       moved to an ASM in the period
 *   visited   first visit marked visited in the period, split into the old
 *             backlog (pending) and the new
 *   left      left the queue without a visit: "Visit not needed", handed back
 *             to the ISR, or Lost
 *   moved     moved on without a visit for any other reason: to another ASM
 *             (it is then new for that ASM), quote approved, re-transferred, …
 *   waiting   still waiting at the end of the last day
 *
 * so that, for every ASM and in total,
 *
 *   pending + new = visited + left + moved + waiting.
 *
 * % visited = visited ÷ (pending + new).
 *
 * Nothing stores a daily snapshot of the queue, so the record rebuilds it:
 *   - Each move into Transferred_to_ASM (dealer_lead_status_history) opens a
 *     wait. A lead sitting in Transferred_to_ASM with no history row waits from
 *     assigned_at / created_at, like TRANSFER_AT_EXPR.
 *   - The wait closes at the first visit marked visited since the move (the
 *     same "since" test as transferVisitLimit.ts) or at the next status change,
 *     whichever is first.
 *   - Inside a wait, every ownership move to a field person (an ASM swap:
 *     asm_transfer from assignOwner, or the ASM's own reassign) closes the old
 *     ASM's part as "moved" and opens a new part for the new ASM. One part per
 *     (lead, ASM) = one "segment" below.
 *
 * "Past the limit" uses the lead's clock: working days (Mon–Sat, active
 * holidays off, IST) since the move into Transferred_to_ASM. Each wait is judged
 * by the asm_transfer_first_visit limit in force on the day of that move (ID 85:
 * dated limits), so a past period keeps the limit it was run under. A period
 * ending today therefore matches the card (transferVisitOverdueSql) exactly.
 *
 * The state filter reads the lead as it is today. The person / team filters
 * read the segment's ASM. Deactivated leads are left out, as on the card.
 *
 * fieldVisitSegmentsSql() is the ONE query: the per-ASM counts below and the
 * drill lists (salesDrill.ts fv_* kinds) both read it, so a list behind a
 * number has exactly as many rows as the number says.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { workingDaysBetweenSql } from "@/lib/calendar/holidays";
import { limitOnDay } from "@/lib/timeLimits/store";
import { currentTeamOf } from "@/lib/users/team";
import type { ActionScope } from "@/lib/dashboard/salesHeadActions";

export const FV_MEASURES = [
    "pending",
    "new",
    "visited",
    "visited_backlog",
    "visited_new",
    "left",
    "moved",
    "waiting",
    "past_limit",
] as const;
export type FvMeasure = (typeof FV_MEASURES)[number];

export type FieldVisitCounts = {
    pending: number;
    new: number;
    visited: number;
    visitedBacklog: number;
    visitedNew: number;
    /** Of the visits, how many within the limit. */
    visitedInLimit: number;
    left: number;
    moved: number;
    waiting: number;
    /** Of those still waiting at the end, how many are past the limit. */
    pastLimit: number;
    /** Average working days from the move into the queue to the visit, for visits in the period. */
    avgDaysToVisit: number | null;
};

export type FieldVisitRow = FieldVisitCounts & {
    /** The ASM (or field person) — null for leads with no field owner. */
    id: string | null;
    name: string;
    /** For a team subtotal: the people it sums (manager and members). */
    members?: string[];
};

export type FieldVisitPeriod = {
    from: string;
    to: string;
    total: FieldVisitCounts;
    /** One row per ASM with any segment in the period, most still waiting first. */
    asms: FieldVisitRow[];
    /** A subtotal per manager whose team has a row here (the manager's own row included). */
    teams: FieldVisitRow[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_ROLES = ["asm", "sales_manager"];

/** Today's date in IST, YYYY-MM-DD. */
export function istToday(): string {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD shifted by `days`. */
export function shiftDay(day: string, days: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** A valid YYYY-MM-DD or the fallback. */
export function dayOr(v: string | null | undefined, fallback: string): string {
    return v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : fallback;
}

/** % visited = visited ÷ (pending + new); null when nothing was in the queue. */
export function pctVisited(c: Pick<FieldVisitCounts, "visited" | "pending" | "new">): number | null {
    const of = c.pending + c.new;
    return of > 0 ? Math.round((c.visited / of) * 100) : null;
}

/** The person / team filter on the segment's ASM (`seg.asm_id`). */
function segScope(s: ActionScope): SQL {
    const parts: SQL[] = [];
    if (s.ownerId) parts.push(sql`seg.asm_id = ${s.ownerId}`);
    const roles = s.team === "field" ? FIELD_ROLES : s.team === "inside" ? ["inside_sales_rep"] : null;
    if (roles) {
        const list = sql.raw(roles.map((r) => `'${r}'`).join(", "));
        parts.push(sql`EXISTS (SELECT 1 FROM users ur WHERE ur.id::text = seg.asm_id AND ur.role IN (${list}))`);
    }
    return parts.length ? sql` AND ${sql.join(parts, sql` AND `)}` : sql``;
}

/**
 * Every segment of the visit queue that overlaps [from, to] (IST days,
 * inclusive), one row per (lead, ASM part), with a boolean per measure:
 *
 *   lead_id, asm_id, wait_start, seg_start, seg_end, end_kind, lim,
 *   days_to_visit, pending, is_new, visited, visited_backlog, visited_new,
 *   visited_in_limit, left_q, moved, waiting, past_limit
 *
 * Exactly one of visited / left_q / moved / waiting is true on every row.
 */
export async function fieldVisitSegmentsSql(s: ActionScope, fromDay: string, toDay: string): Promise<SQL> {
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    const limitOn = await limitOnDay("asm_transfer_first_visit");
    const lim = sql`FLOOR(${limitOn(sql`(wait_start AT TIME ZONE 'Asia/Kolkata')::date`)})`;
    // Period bounds as instants: IST midnight of the first day, IST midnight after the last.
    const A = sql`((${fromDay})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    const B = sql`(((${toDay})::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    const lastMoment = sql`LEAST(${B} - INTERVAL '1 second', NOW())`;
    const fieldRoles = sql.raw(FIELD_ROLES.map((r) => `'${r}'`).join(", "));
    const state = s.state ? sql`AND lower(trim(dl.state)) = lower(trim(${s.state}))` : sql``;

    return sql`
        WITH starts AS (
            SELECT h.dealer_lead_id AS lead_id, h.changed_at AS start_at
              FROM dealer_lead_status_history h
             WHERE h.to_status = 'Transferred_to_ASM'
            UNION ALL
            SELECT d.id, COALESCE(d.assigned_at, d.created_at)
              FROM dealer_leads d
             WHERE d.lead_status = 'Transferred_to_ASM'
               AND NOT EXISTS (SELECT 1 FROM dealer_lead_status_history h
                                WHERE h.dealer_lead_id = d.id AND h.to_status = 'Transferred_to_ASM')
        ),
        iv AS (
            SELECT st.lead_id, st.start_at, nx.changed_at AS left_at, nx.to_status AS left_to, nx.reason_notes AS left_note,
                   (SELECT MIN(GREATEST(st.start_at, COALESCE(
                               (v.actual_visit_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'Asia/Kolkata',
                               v.created_at)))
                      FROM lead_visits v
                     WHERE v.dealer_lead_id = st.lead_id
                       AND v.visit_status = 'visited'
                       AND (v.created_at >= st.start_at
                            OR v.actual_visit_date >= (st.start_at AT TIME ZONE 'Asia/Kolkata')::date)) AS visit_at
              FROM starts st
              JOIN dealer_leads dl ON dl.id = st.lead_id
              LEFT JOIN LATERAL (
                    SELECT h.changed_at, h.to_status, h.reason_notes FROM dealer_lead_status_history h
                     WHERE h.dealer_lead_id = st.lead_id AND h.changed_at > st.start_at
                     ORDER BY h.changed_at ASC LIMIT 1) nx ON TRUE
             WHERE dl.is_active IS NOT FALSE
               AND st.start_at < ${B}
               ${state}
        ),
        w AS (
            SELECT lead_id, start_at,
                   LEAST(left_at, visit_at) AS end_at,
                   CASE WHEN visit_at IS NOT NULL AND (left_at IS NULL OR visit_at <= left_at) THEN 'visit'
                        WHEN left_at IS NULL THEN NULL
                        WHEN left_to = 'Lost'
                          OR left_note LIKE 'Visit not needed:%'
                          OR left_note LIKE '%before the field visit; back to the pre-transfer stage%' THEN 'left'
                        ELSE 'moved' END AS end_kind
              FROM iv
        ),
        wp AS (
            SELECT * FROM w WHERE end_at IS NULL OR end_at >= ${A}
        ),
        sw AS (
            -- An ownership move to a field person inside an open wait: an ASM swap.
            -- The transfer's own asm_transfer row (written with the status change)
            -- is skipped by the 5-second margin.
            SELECT wp.lead_id, wp.start_at AS wait_start, t.performed_at AS at,
                   t.from_owner_id AS from_asm, t.to_owner_id AS to_asm
              FROM wp
              JOIN lead_touchpoints t ON t.dealer_lead_id = wp.lead_id
                                     AND t.performed_at > wp.start_at + INTERVAL '5 seconds'
                                     AND (wp.end_at IS NULL OR t.performed_at < wp.end_at)
                                     AND t.to_owner_id IS NOT NULL
                                     AND t.to_owner_id IS DISTINCT FROM t.from_owner_id
              JOIN users tu ON tu.id::text = t.to_owner_id AND tu.role IN (${fieldRoles})
        ),
        bounds AS (
            SELECT lead_id, start_at AS wait_start, start_at AS at, NULL::text AS from_asm, NULL::text AS to_asm FROM wp
            UNION ALL
            SELECT lead_id, wait_start, at, from_asm, to_asm FROM sw
        ),
        b2 AS (
            SELECT b.*, LEAD(b.at) OVER p AS next_at, LEAD(b.from_asm) OVER p AS next_from
              FROM bounds b
            WINDOW p AS (PARTITION BY b.lead_id, b.wait_start ORDER BY b.at)
        ),
        seg AS (
            SELECT b2.lead_id, b2.wait_start, b2.at AS seg_start,
                   COALESCE(b2.next_at, wp.end_at) AS seg_end,
                   CASE WHEN b2.next_at IS NOT NULL THEN 'moved' ELSE wp.end_kind END AS end_kind,
                   COALESCE(b2.to_asm, t0.asm, b2.next_from, dl.asm_id, dl.current_owner_id) AS asm_id
              FROM b2
              JOIN wp ON wp.lead_id = b2.lead_id AND wp.start_at = b2.wait_start
              JOIN dealer_leads dl ON dl.id = b2.lead_id
              LEFT JOIN LATERAL (
                    SELECT t.to_owner_id AS asm FROM lead_touchpoints t
                     WHERE b2.to_asm IS NULL
                       AND t.dealer_lead_id = b2.lead_id AND t.touchpoint_type = 'asm_transfer'
                       AND t.performed_at BETWEEN b2.at - INTERVAL '1 minute' AND b2.at + INTERVAL '5 seconds'
                     ORDER BY t.performed_at DESC LIMIT 1) t0 ON TRUE
        ),
        m AS (
            SELECT seg.*,
                   (seg_start < ${A}) AS pending,
                   (seg_start >= ${A}) AS is_new,
                   (seg_end IS NOT NULL AND seg_end < ${B}) AS ended
              FROM seg
             WHERE seg_start < ${B} AND (seg_end IS NULL OR seg_end >= ${A})
                   ${segScope(s)}
        ),
        x AS (
            SELECT m.*, ${lim} AS lim,
                   (ended AND end_kind = 'visit') AS visited,
                   (ended AND end_kind = 'left') AS left_q,
                   (ended AND end_kind = 'moved') AS moved,
                   (NOT ended) AS waiting,
                   CASE WHEN ended AND end_kind = 'visit'
                        THEN ${workingDaysBetweenSql(sql`wait_start`, sql`seg_end`)} END AS days_to_visit,
                   CASE WHEN NOT ended
                        THEN ${workingDaysBetweenSql(sql`wait_start`, lastMoment)} END AS age_end
              FROM m
        )
        SELECT x.lead_id, x.asm_id, x.wait_start, x.seg_start, x.seg_end, x.end_kind, x.lim, x.days_to_visit, x.age_end,
               x.pending, x.is_new, x.visited,
               (x.visited AND x.pending) AS visited_backlog,
               (x.visited AND x.is_new) AS visited_new,
               (x.visited AND x.days_to_visit <= x.lim) AS visited_in_limit,
               x.left_q, x.moved, x.waiting,
               (x.waiting AND x.age_end > x.lim) AS past_limit
          FROM x`;
}

/** The boolean column of fieldVisitSegmentsSql() behind one measure. */
export const FV_COLUMN: Record<FvMeasure, string> = {
    pending: "pending",
    new: "is_new",
    visited: "visited",
    visited_backlog: "visited_backlog",
    visited_new: "visited_new",
    left: "left_q",
    moved: "moved",
    waiting: "waiting",
    past_limit: "past_limit",
};

type Raw = Record<string, unknown>;

const zero = (): FieldVisitCounts => ({
    pending: 0,
    new: 0,
    visited: 0,
    visitedBacklog: 0,
    visitedNew: 0,
    visitedInLimit: 0,
    left: 0,
    moved: 0,
    waiting: 0,
    pastLimit: 0,
    avgDaysToVisit: null,
});

/** Sum rows; the average is weighted by visits. */
function sum(rows: Array<FieldVisitCounts>): FieldVisitCounts {
    const t = zero();
    let daySum = 0;
    for (const r of rows) {
        t.pending += r.pending;
        t.new += r.new;
        t.visited += r.visited;
        t.visitedBacklog += r.visitedBacklog;
        t.visitedNew += r.visitedNew;
        t.visitedInLimit += r.visitedInLimit;
        t.left += r.left;
        t.moved += r.moved;
        t.waiting += r.waiting;
        t.pastLimit += r.pastLimit;
        if (r.avgDaysToVisit != null) daySum += r.avgDaysToVisit * r.visited;
    }
    t.avgDaysToVisit = t.visited > 0 ? Math.round((daySum / t.visited) * 10) / 10 : null;
    return t;
}

/** The visit queue for one period, [from, to] inclusive, IST days: per ASM, per team and in total. */
export async function fieldVisitPeriod(s: ActionScope, fromDay: string, toDay: string): Promise<FieldVisitPeriod> {
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    const segments = await fieldVisitSegmentsSql(s, fromDay, toDay);
    const [rows, teamOf] = await Promise.all([
        db.execute(sql`
            SELECT g.asm_id, u.name,
                   COUNT(*) FILTER (WHERE g.pending)::int AS pending,
                   COUNT(*) FILTER (WHERE g.is_new)::int AS is_new,
                   COUNT(*) FILTER (WHERE g.visited)::int AS visited,
                   COUNT(*) FILTER (WHERE g.visited_backlog)::int AS visited_backlog,
                   COUNT(*) FILTER (WHERE g.visited_new)::int AS visited_new,
                   COUNT(*) FILTER (WHERE g.visited_in_limit)::int AS visited_in_limit,
                   COUNT(*) FILTER (WHERE g.left_q)::int AS left_q,
                   COUNT(*) FILTER (WHERE g.moved)::int AS moved,
                   COUNT(*) FILTER (WHERE g.waiting)::int AS waiting,
                   COUNT(*) FILTER (WHERE g.past_limit)::int AS past_limit,
                   AVG(g.days_to_visit)::float AS avg_days
              FROM (${segments}) g
              LEFT JOIN users u ON u.id::text = g.asm_id
             GROUP BY g.asm_id, u.name`) as unknown as Promise<Raw[]>,
        currentTeamOf(),
    ]);

    const asms: FieldVisitRow[] = rows
        .map((r) => ({
            id: r.asm_id == null ? null : String(r.asm_id),
            name: r.name ? String(r.name) : r.asm_id == null ? "No field owner" : "Unknown person",
            pending: Number(r.pending ?? 0),
            new: Number(r.is_new ?? 0),
            visited: Number(r.visited ?? 0),
            visitedBacklog: Number(r.visited_backlog ?? 0),
            visitedNew: Number(r.visited_new ?? 0),
            visitedInLimit: Number(r.visited_in_limit ?? 0),
            left: Number(r.left_q ?? 0),
            moved: Number(r.moved ?? 0),
            waiting: Number(r.waiting ?? 0),
            pastLimit: Number(r.past_limit ?? 0),
            avgDaysToVisit: r.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10,
        }))
        .sort((a, b) => b.waiting - a.waiting || b.pending + b.new - (a.pending + a.new) || a.name.localeCompare(b.name));

    // A subtotal per manager: the manager's own row plus each member on their current line.
    const byManager = new Map<string, FieldVisitRow[]>();
    for (const r of asms) {
        if (!r.id) continue;
        const mgr = teamOf.get(r.id) ?? ([...teamOf.values()].includes(r.id) ? r.id : null);
        if (!mgr) continue;
        byManager.set(mgr, [...(byManager.get(mgr) ?? []), r]);
    }
    const mgrIds = [...byManager.keys()];
    const mgrNames = new Map(
        mgrIds.length
            ? ((await db.execute(sql`
                  SELECT id::text AS id, name FROM users WHERE id::text IN (${sql.join(mgrIds.map((i) => sql`${i}`), sql`, `)})
              `)) as unknown as Raw[]).map((r) => [String(r.id), String(r.name ?? "")] as const)
            : [],
    );
    const teams: FieldVisitRow[] = [...byManager.entries()]
        .map(([mgr, rs]) => ({
            ...sum(rs),
            id: mgr,
            name: `Team subtotal · ${mgrNames.get(mgr) || "manager"}`,
            members: rs.map((r) => r.id!).filter(Boolean),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return { from: fromDay, to: toDay, total: sum(asms), asms, teams };
}

/** pending + new = visited + left + moved + waiting — true on every row by construction. */
export function fieldVisitBalances(c: FieldVisitCounts): boolean {
    return c.pending + c.new === c.visited + c.left + c.moved + c.waiting && c.visited === c.visitedBacklog + c.visitedNew;
}
