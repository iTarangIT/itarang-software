/**
 * "Waiting for a field visit" over time — ageing and a two-period comparison
 * for the Sales Head (is the visit queue shrinking, are ASMs visiting faster?).
 *
 * Nothing stores a daily snapshot of the queue, so a past day is rebuilt from
 * the record: each move into Transferred_to_ASM (dealer_lead_status_history)
 * opens a wait; it closes at the first visit marked visited since the move
 * (the same "since" test as transferVisitLimit.ts) or at the next status
 * change, whichever is first. A re-transfer closes the old wait and opens a
 * new one, as it restarts the clock on the card. A lead sitting in
 * Transferred_to_ASM with no history row waits from assigned_at / created_at,
 * like TRANSFER_AT_EXPR.
 *
 * Ages are working days (Mon–Sat, active holidays off, IST) from the move to
 * the day measured. "Past the limit" judges each wait by the
 * asm_transfer_first_visit limit in force on the day of its transfer (ID 85:
 * dated limits, 15 Oct) — so a past period keeps the limit it was run under,
 * and a period ending today matches the card. The ageing buckets are drawn at
 * the limit in force on the period's last day.
 *
 * The filters (state / person / team) read the lead as it is today, and
 * deactivated leads are left out, as on the card.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { workingDaysBetweenSql } from "@/lib/calendar/holidays";
import { getTimeLimits, limitOnDay } from "@/lib/timeLimits/store";
import { actionScopeSql, type ActionScope } from "@/lib/dashboard/salesHeadActions";

export type AgeBucket = { label: string; count: number; overLimit: boolean };

export type FieldVisitPeriod = {
    from: string;
    to: string;
    /** Waiting at the start of the first day. */
    waitingAtStart: number;
    /** Waiting at the end of the last day. */
    waitingAtEnd: number;
    /** Of those waiting at the end, how many were past the limit. */
    overdueAtEnd: number;
    /** New transfers to an ASM in the period (re-transfers left out). */
    transferred: number;
    /** First visits marked visited in the period. */
    visited: number;
    /** Of those, visited within the limit. */
    visitedInLimit: number;
    /** Average working days from transfer to first visit, for visits in the period. */
    avgDaysToVisit: number | null;
    /** Left the visit queue in the period without a visit (moved on, lost, …). */
    leftWithoutVisit: number;
    /** Waiting at the end, by working days since transfer. */
    ageing: AgeBucket[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

/** Bucket edges in working days: within the limit, then up to 7, 14, 30, and older. */
function buckets(limit: number, ages: number[]): AgeBucket[] {
    const edges = [limit, ...[7, 14, 30].filter((e) => e > limit)];
    const out: AgeBucket[] = [];
    let lo = 0;
    for (const hi of edges) {
        out.push({
            label: `${lo === hi ? `${hi}` : `${lo}–${hi}`} days${hi === limit ? " (within limit)" : ""}`,
            count: ages.filter((a) => a >= lo && a <= hi).length,
            overLimit: lo > limit,
        });
        lo = hi + 1;
    }
    out.push({ label: `Over ${lo - 1} days`, count: ages.filter((a) => a >= lo).length, overLimit: true });
    return out;
}

/** The visit queue for one period, [from, to] inclusive, IST days. */
export async function fieldVisitPeriod(s: ActionScope, fromDay: string, toDay: string): Promise<FieldVisitPeriod> {
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    const limit = Math.max(0, Math.floor((await getTimeLimits(toDay)).asm_transfer_first_visit));
    const limitOn = await limitOnDay("asm_transfer_first_visit");
    const lim = sql`FLOOR(${limitOn(sql`(start_at AT TIME ZONE 'Asia/Kolkata')::date`)})`;
    // Period bounds as instants: IST midnight of the first day, IST midnight after the last.
    const A = sql`((${fromDay})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    const B = sql`(((${toDay})::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    const lastMoment = sql`(${B} - INTERVAL '1 second')`;
    const inPeriod = (col: SQL) => sql`(${col} >= ${A} AND ${col} < ${B})`;

    const rows = (await db.execute(sql`
        WITH starts AS (
            SELECT h.dealer_lead_id AS lead_id, h.changed_at AS start_at,
                   (h.from_status IS DISTINCT FROM 'Transferred_to_ASM') AS is_new
              FROM dealer_lead_status_history h
             WHERE h.to_status = 'Transferred_to_ASM'
            UNION ALL
            SELECT d.id, COALESCE(d.assigned_at, d.created_at), TRUE
              FROM dealer_leads d
             WHERE d.lead_status = 'Transferred_to_ASM'
               AND NOT EXISTS (SELECT 1 FROM dealer_lead_status_history h
                                WHERE h.dealer_lead_id = d.id AND h.to_status = 'Transferred_to_ASM')
        ),
        iv AS (
            SELECT st.start_at, st.is_new, nx.changed_at AS left_at, nx.to_status AS left_to,
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
                    SELECT h.changed_at, h.to_status FROM dealer_lead_status_history h
                     WHERE h.dealer_lead_id = st.lead_id AND h.changed_at > st.start_at
                     ORDER BY h.changed_at ASC LIMIT 1) nx ON TRUE
             WHERE dl.is_active IS NOT FALSE
               AND st.start_at < ${B}
               ${actionScopeSql(s, "owner_or_asm")}
        ),
        w AS (
            SELECT start_at, is_new, left_to,
                   LEAST(left_at, visit_at) AS end_at,
                   (visit_at IS NOT NULL AND (left_at IS NULL OR visit_at <= left_at)) AS by_visit
              FROM iv
        ),
        m AS (
            SELECT w.*,
                   (start_at < ${A} AND (end_at IS NULL OR end_at >= ${A})) AS waiting_start,
                   (end_at IS NULL OR end_at >= ${B}) AS waiting_end
              FROM w
             WHERE end_at IS NULL OR end_at >= ${A}
        ),
        x AS (
            SELECT m.*, ${lim} AS lim,
                   CASE WHEN waiting_end THEN ${workingDaysBetweenSql(sql`start_at`, lastMoment)} END AS age_end,
                   CASE WHEN by_visit AND ${inPeriod(sql`end_at`)}
                        THEN ${workingDaysBetweenSql(sql`start_at`, sql`end_at`)} END AS days_to_visit
              FROM m
        )
        SELECT
            COUNT(*) FILTER (WHERE waiting_start)::int AS waiting_start,
            COUNT(*) FILTER (WHERE waiting_end)::int AS waiting_end,
            COUNT(*) FILTER (WHERE is_new AND ${inPeriod(sql`start_at`)})::int AS transferred,
            COUNT(days_to_visit)::int AS visited,
            COUNT(*) FILTER (WHERE days_to_visit <= lim)::int AS visited_in_limit,
            COUNT(*) FILTER (WHERE age_end > lim)::int AS overdue_end,
            AVG(days_to_visit)::float AS avg_days,
            COUNT(*) FILTER (WHERE NOT by_visit AND end_at IS NOT NULL AND ${inPeriod(sql`end_at`)}
                              AND left_to IS DISTINCT FROM 'Transferred_to_ASM')::int AS left_without_visit,
            COALESCE(array_agg(age_end) FILTER (WHERE age_end IS NOT NULL), '{}') AS ages
          FROM x`)) as unknown as Array<Record<string, unknown>>;

    const r = rows[0] ?? {};
    const ages = ((r.ages as unknown[]) ?? []).map(Number);
    return {
        from: fromDay,
        to: toDay,
        waitingAtStart: Number(r.waiting_start ?? 0),
        waitingAtEnd: Number(r.waiting_end ?? 0),
        overdueAtEnd: Number(r.overdue_end ?? 0),
        transferred: Number(r.transferred ?? 0),
        visited: Number(r.visited ?? 0),
        visitedInLimit: Number(r.visited_in_limit ?? 0),
        avgDaysToVisit: r.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10,
        leftWithoutVisit: Number(r.left_without_visit ?? 0),
        ageing: buckets(limit, ages),
    };
}
