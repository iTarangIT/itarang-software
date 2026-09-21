/**
 * The manager's needs-attention list (review R-15, Requirement #6 point 4):
 * every open lead someone is holding and not working, oldest first, with who
 * holds it, how long it has sat, and what happened last — so the manager can
 * reassign from the row instead of opening each lead.
 *
 *   Idle      working days (Mon–Sat) since dealer_leads.last_worked_at — the
 *             E-300 clock: only a call, visit or status change resets it.
 *             Never-worked leads count from when the holder got them.
 *   Threshold #6: a CC / inside-sales holder is listed from 5 idle days, an
 *             ASM from 7. Other holders use 5.
 *   Non-responsive (R-16) leads are returned with non_responsive = true and
 *             kept OUT of the idle totals — a dead number is not neglect. The
 *             page shows them as their own bucket.
 *
 * Shared by the /admin/needs-attention page and the weekly idle email, so the
 * list and the mail cannot disagree.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { OPEN_STATUSES } from "@/lib/lifecycle/transitions";
import { nonResponsiveSql } from "@/lib/leads/nonResponsive";

export const IDLE_THRESHOLD_CC = 5;
export const IDLE_THRESHOLD_ASM = 7;

export type NeedsAttentionRow = {
    lead_id: string;
    dealer: string;
    city: string | null;
    holder_id: string;
    holder_name: string | null;
    holder_role: string | null;
    lead_status: string | null;
    interest_level: string | null;
    days_idle: number;
    last_worked_at: string | null;
    last_disposition: string | null;
    last_disposition_bucket: string | null;
    non_responsive: boolean;
};

const OPEN_LIST = sql.raw(OPEN_STATUSES.map((s) => `'${s}'`).join(", "));
const IDLE_BASIS = sql`COALESCE(dl.last_worked_at, dl.assigned_at, dl.created_at)`;
/** Mon–Sat days elapsed since the basis, Sundays excluded — as the admin dashboard counts. */
const DAYS_IDLE = sql`(
    SELECT COUNT(*) FROM generate_series(
        ((${IDLE_BASIS} AT TIME ZONE 'Asia/Kolkata')::date + 1),
        (now() AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day'
    ) gs WHERE EXTRACT(DOW FROM gs) <> 0
)`;

type Opts = {
    holderId?: string | null;
    /** Override the per-role threshold (the weekly mail uses 7 for everyone). */
    minDays?: number;
};

/** Every lead over its threshold, as a subquery `x` — no ORDER, no LIMIT. */
function baseQuery(opts: Opts): SQL {
    const threshold =
        opts.minDays != null
            ? sql`${opts.minDays}::int`
            : sql`CASE WHEN lower(u.role) = 'asm' THEN ${IDLE_THRESHOLD_ASM}::int ELSE ${IDLE_THRESHOLD_CC}::int END`;
    return sql`(SELECT * FROM (
            SELECT dl.id                                         AS lead_id,
                   COALESCE(dl.shop_name, dl.dealer_name, '(unnamed)') AS dealer,
                   dl.city,
                   dl.current_owner_id                           AS holder_id,
                   u.name                                        AS holder_name,
                   u.role                                        AS holder_role,
                   dl.lead_status,
                   dl.interest_level,
                   ${DAYS_IDLE}::int                             AS days_idle,
                   dl.last_worked_at,
                   dl.last_disposition,
                   dl.last_disposition_bucket,
                   ${nonResponsiveSql(sql`dl.id`)}               AS non_responsive,
                   ${threshold}                                  AS threshold
              FROM dealer_leads dl
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE dl.current_owner_id IS NOT NULL
               AND dl.is_active IS NOT FALSE
               AND dl.lead_status IN (${OPEN_LIST})
               ${opts.holderId ? sql`AND dl.current_owner_id = ${opts.holderId}` : sql``}
        ) y
         WHERE y.days_idle >= y.threshold)`;
}

/** The oldest `limit` rows (idle first, then non-responsive). */
export async function listNeedsAttention(
    opts: Opts & { limit?: number } = {},
): Promise<NeedsAttentionRow[]> {
    const rows = await db.execute(sql`
        SELECT * FROM ${baseQuery(opts)} x
         ORDER BY x.non_responsive ASC, x.days_idle DESC, x.dealer ASC
         LIMIT ${Math.min(Math.max(opts.limit ?? 500, 1), 2000)}::int
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        lead_id: String(r.lead_id),
        dealer: String(r.dealer),
        city: (r.city as string | null) ?? null,
        holder_id: String(r.holder_id),
        holder_name: (r.holder_name as string | null) ?? null,
        holder_role: (r.holder_role as string | null) ?? null,
        lead_status: (r.lead_status as string | null) ?? null,
        interest_level: (r.interest_level as string | null) ?? null,
        days_idle: Number(r.days_idle ?? 0),
        last_worked_at: r.last_worked_at ? new Date(r.last_worked_at as string).toISOString() : null,
        last_disposition: (r.last_disposition as string | null) ?? null,
        last_disposition_bucket: (r.last_disposition_bucket as string | null) ?? null,
        non_responsive: Boolean(r.non_responsive),
    }));
}

export type NeedsAttentionHolderSummary = {
    holder_id: string;
    holder_name: string | null;
    holder_role: string | null;
    idle: number;
    idle_over_14: number;
    oldest_days: number;
    non_responsive: number;
};

/**
 * Per-holder totals over EVERY matching lead — no cap. The list is capped for
 * the screen; totals must never be (production carries thousands of idle
 * leads, and a capped count reads as a real one).
 */
export async function summarizeNeedsAttention(opts: Opts = {}): Promise<NeedsAttentionHolderSummary[]> {
    const rows = await db.execute(sql`
        SELECT x.holder_id, MAX(x.holder_name) AS holder_name, MAX(x.holder_role) AS holder_role,
               COUNT(*) FILTER (WHERE NOT x.non_responsive)::int                     AS idle,
               COUNT(*) FILTER (WHERE NOT x.non_responsive AND x.days_idle > 14)::int AS idle_over_14,
               COALESCE(MAX(x.days_idle) FILTER (WHERE NOT x.non_responsive), 0)::int AS oldest_days,
               COUNT(*) FILTER (WHERE x.non_responsive)::int                         AS non_responsive
          FROM ${baseQuery(opts)} x
         GROUP BY x.holder_id
         ORDER BY idle DESC
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        holder_id: String(r.holder_id),
        holder_name: (r.holder_name as string | null) ?? null,
        holder_role: (r.holder_role as string | null) ?? null,
        idle: Number(r.idle ?? 0),
        idle_over_14: Number(r.idle_over_14 ?? 0),
        oldest_days: Number(r.oldest_days ?? 0),
        non_responsive: Number(r.non_responsive ?? 0),
    }));
}
