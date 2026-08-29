// Centralised SQL builder for the 5 queue tabs (BRD §0.5).
// Raw SQL via db.execute() so we can hand-tune the JOINs to users + the
// "team" tab's status-open filter without verbose Drizzle chains.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import type { QueueRow, QueueTab } from "./types";
import { OPEN_STATUSES, TERMINAL_STATUSES } from "@/lib/lifecycle/transitions";
import { NEODOVE_LINKED_SYNC_STATUSES } from "@/lib/neodove/syncStatus";
import {
    foldRegionFacets,
    queueFilterClauses,
    queueSortOrder,
    regionFacetQuery,
    type QueueFilterInput,
} from "@/lib/leads/queueFilterSql";
import type { QueueRegion } from "@/lib/leads/queueFilters";
import type { QueueSort } from "@/lib/leads/queueSort";

const OPEN_LIST = sql.raw(
    OPEN_STATUSES.map((s) => `'${s}'`).join(", "),
);
const TERMINAL_LIST = sql.raw(
    TERMINAL_STATUSES.map((s) => `'${s}'`).join(", "),
);

// ⚠ READ neodove_sync_status THROUGH to_jsonb, NEVER BY NAME.
//
// The column is E-224's and is deliberately absent from schema.ts. Every query
// in this module is raw SQL in ONE statement — the tab counts are five
// subqueries in a single round trip — and a missing column fails at PARSE time,
// so naming it directly would take the entire Inside Sales workspace down on any
// database without E-224 rather than merely showing no NeoDove leads. Prod
// (database-2) has no neodove_* objects at all today.
//
// to_jsonb(dl) is a per-row serialisation and therefore cannot use
// dealer_leads_neodove_sync_idx. That is a deliberate trade: the alternative is
// a fully working screen that 500s the moment someone touches the filter.
const NEODOVE_STATUS = sql`to_jsonb(dl) ->> 'neodove_sync_status'`;
const NEODOVE_LINKED_LIST = sql.raw(
    NEODOVE_LINKED_SYNC_STATUSES.map((s) => `'${s}'`).join(", "),
);

type BuildArgs = {
    tab: QueueTab;
    userId: string;
    page: number;
    limit: number;
    q?: string | null;
    /** Restrict to leads that are with the NeoDove calling team. */
    neodoveOnly?: boolean;
    /** Only leads who asked to be called back — from either system. */
    callbackOnly?: boolean;
    /** Stage / interest / region / date range — see @/lib/leads/queueFilters. */
    filters?: QueueFilterInput;
    /** User-chosen column + direction; the tab order stays as the tiebreak. */
    sort?: QueueSort;
};

/**
 * The date a `from`/`to` range means on THIS queue.
 *
 * When the lead ARRIVED. A rep's range question is "what came in last week" —
 * they are looking at a backlog, and the useful axis is intake. (The ASM queue
 * ranges over the visit date instead, because their question is "what am I out
 * seeing this week".)
 */
const ISR_DATE_COLUMN = sql`dl.created_at`;

function tabFilter(tab: QueueTab, userId: string) {
    switch (tab) {
        case "my_open":
            return sql`dl.current_owner_id = ${userId} AND dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "follow_ups":
            return sql`dl.current_owner_id = ${userId} AND dl.next_follow_up_at IS NOT NULL AND dl.next_follow_up_at <= NOW() AND dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "unassigned":
            // "Claimable" = anything nobody owns and isn't terminal — not just
            // lead_status = 'New_Unassigned'. Manual-upload / scraped leads are
            // inserted with lead_status = NULL on purpose (so the AI dialer can
            // cold-dial them — see api/admin/leads/bulk) and so were invisible
            // to every queue. Owner-IS-NULL + not-terminal surfaces them here.
            return sql`dl.current_owner_id IS NULL AND dl.lead_status IS DISTINCT FROM 'Converted' AND dl.lead_status IS DISTINCT FROM 'Lost' AND dl.is_active IS NOT FALSE`;
        case "team":
            return sql`dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "my_closed":
            return sql`dl.current_owner_id = ${userId} AND dl.lead_status IN (${TERMINAL_LIST}) AND dl.closed_at >= NOW() - INTERVAL '90 days' AND dl.is_active IS NOT FALSE`;
    }
}

/**
 * The filters that apply on top of the tab — search box and NeoDove.
 *
 * One helper rather than the clause being written out at each call site: it was
 * already duplicated verbatim between fetchQueueRows and countQueueRows, and the
 * list and its own "Showing 1–N of T" disagreeing is exactly what a second copy
 * drifting produces.
 */
function extraFilters({
    q,
    neodoveOnly,
    callbackOnly,
    filters,
}: Pick<BuildArgs, "q" | "neodoveOnly" | "callbackOnly" | "filters">) {
    const parts: SQL[] = [];
    if (q) {
        const like = `%${q}%`;
        parts.push(
            sql` AND (dl.dealer_name ILIKE ${like} OR dl.phone ILIKE ${like} OR dl.shop_name ILIKE ${like})`,
        );
    }
    if (neodoveOnly) {
        parts.push(sql` AND ${NEODOVE_STATUS} IN (${NEODOVE_LINKED_LIST})`);
    }
    // "Who asked us to call back" — from EITHER system, because the rep asking
    // does not care whether a robot or a telecaller recorded it.
    //
    // ⚠ The E-236 column goes through to_jsonb here, unlike on /leads where it
    // is named directly. fetchAllTabCounts builds all five tab badges as five
    // subqueries in ONE statement, so a parse-time failure on a database
    // without E-236 would take the whole workspace down rather than one filter.
    if (callbackOnly) {
        parts.push(sql` AND (
            EXISTS (SELECT 1 FROM ai_call_logs a
                     WHERE a.lead_id = dl.id
                       AND a.signals ->> 'callback_agreed' = 'yes')
            OR to_jsonb(dl) ->> 'last_disposition' = 'As to Call Back'
        )`);
    }
    if (filters) parts.push(...queueFilterClauses(filters, ISR_DATE_COLUMN));
    return parts.length ? sql.join(parts, sql``) : sql``;
}

/** The tab's own order COLUMNS — queueSortOrder() prepends the user's sort. */
function tabOrder(tab: QueueTab) {
    switch (tab) {
        case "follow_ups":
            return sql`dl.next_follow_up_at ASC NULLS LAST`;
        case "unassigned":
            // Band model: Qualified leads all share lead_score 90, so within a
            // band the queue is ordered by facts disclosed (info_signals_count
            // desc), per docs/intent_docs/intent_score.pdf §3.
            // A callback request is time-sensitive in a way a score is not, so
            // it sorts first: the dealer asked us to ring back, and the AI
            // cannot, so the queue should surface them before anything else.
            return sql`
                EXISTS (SELECT 1 FROM ai_call_logs a
                         WHERE a.lead_id = dl.id
                           AND a.signals ->> 'callback_agreed' = 'yes') DESC,
                dl.final_intent_score DESC NULLS LAST,
                dl.info_signals_count DESC NULLS LAST,
                dl.created_at DESC`;
        case "my_closed":
            return sql`dl.closed_at DESC NULLS LAST`;
        case "team":
        case "my_open":
        default:
            return sql`COALESCE(dl.last_touchpoint_at, dl.assigned_at, dl.created_at) DESC NULLS LAST`;
    }
}

export async function fetchQueueRows({
    tab,
    userId,
    page,
    limit,
    q,
    neodoveOnly,
    callbackOnly,
    filters,
    sort,
}: BuildArgs): Promise<QueueRow[]> {
    const offset = (page - 1) * limit;
    const where = tabFilter(tab, userId);
    const order = queueSortOrder(sort, tabOrder(tab));
    const search = extraFilters({ q, neodoveOnly, callbackOnly, filters });

    const rows = await db.execute<QueueRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.language,
            dl.final_intent_score,
            dl.lead_status,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            dl.last_touchpoint_at,
            dl.next_follow_up_at,
            dl.total_attempts,
            dl.assigned_at,
            dl.created_at,
            dl.updated_at,
            ${NEODOVE_STATUS} AS neodove_sync_status
        FROM dealer_leads dl
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        WHERE ${where} ${search}
        ${order}
        LIMIT ${limit} OFFSET ${offset}
    `);

    return rows as unknown as QueueRow[];
}

export async function countQueueRows({
    tab,
    userId,
    q,
    neodoveOnly,
    callbackOnly,
    filters,
}: Pick<
    BuildArgs,
    "tab" | "userId" | "q" | "neodoveOnly" | "callbackOnly" | "filters"
>): Promise<number> {
    const where = tabFilter(tab, userId);
    const search = extraFilters({ q, neodoveOnly, callbackOnly, filters });
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl WHERE ${where} ${search}
    `);
    return Number(rows[0]?.c ?? 0);
}

/**
 * Badge counts for all five tabs in one round trip.
 *
 * Every filter is threaded through, because a badge that ignores one is worse
 * than no badge: the rep would read "My Open Leads 3" above an empty table and
 * conclude the screen is broken. The search box is deliberately NOT applied here
 * — that is pre-existing behaviour and changing what a badge counts is a
 * separate decision from adding a filter.
 */
export async function fetchAllTabCounts(
    userId: string,
    opts?: Pick<BuildArgs, "neodoveOnly" | "callbackOnly" | "filters">,
): Promise<Record<QueueTab, number>> {
    const extra = extraFilters({
        neodoveOnly: opts?.neodoveOnly,
        callbackOnly: opts?.callbackOnly,
        filters: opts?.filters,
    });
    const rows = await db.execute<{
        my_open: string;
        follow_ups: string;
        unassigned: string;
        team: string;
        my_closed: string;
    }>(sql`
        SELECT
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("my_open", userId)} ${extra}) AS my_open,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("follow_ups", userId)} ${extra}) AS follow_ups,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("unassigned", userId)} ${extra}) AS unassigned,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("team", userId)} ${extra}) AS team,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("my_closed", userId)} ${extra}) AS my_closed
    `);
    const r = rows[0]!;
    return {
        my_open: Number(r.my_open ?? 0),
        follow_ups: Number(r.follow_ups ?? 0),
        unassigned: Number(r.unassigned ?? 0),
        team: Number(r.team ?? 0),
        my_closed: Number(r.my_closed ?? 0),
    };
}

/**
 * The states and cities this rep's queue actually spans, per tab.
 *
 * Feeds the region selects. Deliberately NOT narrowed by the other filters: a
 * dropdown that removes the option you are about to pick as you pick it is
 * unusable, and re-fetching the facets on every keystroke would cost a DISTINCT
 * scan per keystroke to do it.
 */
export async function fetchQueueRegions(
    userId: string,
    tab: QueueTab,
): Promise<QueueRegion[]> {
    const rows = await db.execute<{ state: string | null; city: string | null }>(
        regionFacetQuery(tabFilter(tab, userId)),
    );
    return foldRegionFacets(rows as unknown as { state: string | null; city: string | null }[]);
}
