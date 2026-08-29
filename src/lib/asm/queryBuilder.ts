// SQL builder for the 4 ASM queue tabs (BRD §0.8). Raw SQL via db.execute().
// All tabs join lead_visits to surface the latest visit row's status/date —
// the queue exists to drive the ASM's visit cadence, not just owner status.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AsmQueueRow, AsmQueueTab } from "./types";
import { TERMINAL_STATUSES } from "@/lib/lifecycle/transitions";
import {
    foldRegionFacets,
    queueFilterClauses,
    queueSortOrder,
    regionFacetQuery,
    type QueueFilterInput,
} from "@/lib/leads/queueFilterSql";
import type { QueueRegion } from "@/lib/leads/queueFilters";
import type { QueueSort } from "@/lib/leads/queueSort";

const TERMINAL_LIST = sql.raw(
    TERMINAL_STATUSES.map((s) => `'${s}'`).join(", "),
);

type BuildArgs = {
    tab: AsmQueueTab;
    asmId: string;
    page: number;
    limit: number;
    q?: string | null;
    /** Stage / interest / region / date range — see @/lib/leads/queueFilters. */
    filters?: QueueFilterInput;
    /** The latest visit's lifecycle state — ASM-only. */
    visitStatus?: string | null;
    /** The latest visit's outcome — ASM-only. */
    visitOutcome?: string | null;
    /** User-chosen column + direction; the tab order stays as the tiebreak. */
    sort?: QueueSort;
};

function tabFilter(tab: AsmQueueTab, asmId: string) {
    switch (tab) {
        case "my_visits":
            // Any open lead the ASM owns — not just Transferred_to_ASM. The
            // status-equals filter created ghosts when an admin reassign or
            // any other path set current_owner_id without flipping the status.
            // Ownership + not-terminal is the natural definition of "my active".
            return sql`dl.current_owner_id = ${asmId} AND dl.lead_status NOT IN (${TERMINAL_LIST}) AND dl.is_active IS NOT FALSE`;
        case "today":
            return sql`dl.asm_id = ${asmId} AND lv.scheduled_date = CURRENT_DATE AND lv.visit_status IN ('scheduled','pending_scheduling') AND dl.is_active IS NOT FALSE`;
        case "territory":
            // In-territory leads, OR any lead nobody owns yet — so the ASM sees
            // the same unassigned pool the Inside Sales claim queue surfaces
            // (manual-upload / scraped leads with NULL status included). Either
            // way the lead must be active and not terminal.
            return sql`(
                EXISTS (
                    SELECT 1 FROM asm_territories t
                    WHERE t.asm_id = ${asmId}
                      AND t.state = dl.state
                      AND (t.city IS NULL OR t.city = dl.city)
                      AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                      AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
                )
                OR dl.current_owner_id IS NULL
            ) AND dl.lead_status IS DISTINCT FROM 'Converted' AND dl.lead_status IS DISTINCT FROM 'Lost' AND dl.is_active IS NOT FALSE`;
        case "my_closed":
            return sql`dl.closing_owner_id = ${asmId} AND dl.lead_status IN (${TERMINAL_LIST}) AND dl.closed_at >= NOW() - INTERVAL '90 days' AND dl.is_active IS NOT FALSE`;
    }
}

/** The tab's own order COLUMNS — queueSortOrder() prepends the user's sort. */
function tabOrder(tab: AsmQueueTab) {
    switch (tab) {
        case "today":
            return sql`lv.scheduled_date ASC NULLS LAST, dl.final_intent_score DESC NULLS LAST`;
        case "my_closed":
            return sql`dl.closed_at DESC NULLS LAST`;
        case "territory":
            return sql`dl.final_intent_score DESC NULLS LAST, dl.created_at DESC`;
        case "my_visits":
        default:
            return sql`COALESCE(lv.scheduled_date, dl.assigned_at) ASC NULLS LAST`;
    }
}

// Latest lead_visits row per dealer_lead — drives the visit_status column shown
// in the queue table. LATERAL join keeps it to one row even when a lead has
// multiple visits.
const LATEST_VISIT_JOIN = sql`
    LEFT JOIN LATERAL (
        SELECT visit_status, visit_outcome, scheduled_date, actual_visit_date
        FROM lead_visits
        WHERE dealer_lead_id = dl.id
        ORDER BY COALESCE(actual_visit_date, scheduled_date, created_at) DESC
        LIMIT 1
    ) lv ON true
`;

/**
 * The date a `from`/`to` range means on THIS queue.
 *
 * The VISIT date, not `created_at`. An ASM's range question is "what am I out
 * seeing this week", and a lead created in March that is being visited tomorrow
 * belongs in tomorrow's answer. COALESCE puts a logged visit first, so a
 * completed one is dated when it happened rather than when it was planned. (The
 * Inside Sales queue ranges over intake instead — see ISR_DATE_COLUMN there.)
 */
const ASM_DATE_COLUMN = sql`COALESCE(lv.actual_visit_date, lv.scheduled_date)`;

/**
 * The filters that apply on top of the tab — the search box, the five shared
 * with the Inside Sales queue, and the two that only exist here.
 *
 * One helper rather than the clause being written out at each call site: the
 * search predicate was already duplicated verbatim between fetchAsmQueueRows and
 * countAsmQueueRows, and the list disagreeing with its own "Showing 1–N of T" is
 * exactly what a second copy drifting produces.
 *
 * ⚠ EVERY CALLER MUST HAVE LATEST_VISIT_JOIN IN SCOPE. The visit filters and the
 * date range read `lv`, and a missing alias fails at PARSE time — which is why
 * the count and tab-badge queries join the lateral while selecting nothing from
 * it.
 */
function extraFilters({
    q,
    filters,
    visitStatus,
    visitOutcome,
}: Pick<BuildArgs, "q" | "filters" | "visitStatus" | "visitOutcome">): SQL {
    const parts: SQL[] = [];
    if (q) {
        const like = `%${q}%`;
        parts.push(
            sql` AND (dl.dealer_name ILIKE ${like} OR dl.phone ILIKE ${like} OR dl.shop_name ILIKE ${like})`,
        );
    }
    if (filters) parts.push(...queueFilterClauses(filters, ASM_DATE_COLUMN));
    // The LATEST visit's state, which is what the row's Visit column shows. A
    // lead whose most recent visit was cancelled is a cancelled row here even if
    // an earlier one was productive — filtering on "any visit ever" would answer
    // a question nobody looking at this queue is asking.
    if (visitStatus) parts.push(sql` AND lv.visit_status = ${visitStatus}`);
    if (visitOutcome) parts.push(sql` AND lv.visit_outcome = ${visitOutcome}`);
    return parts.length ? sql.join(parts, sql``) : sql``;
}

export async function fetchAsmQueueRows({
    tab,
    asmId,
    page,
    limit,
    q,
    filters,
    visitStatus,
    visitOutcome,
    sort,
}: BuildArgs): Promise<AsmQueueRow[]> {
    const offset = (page - 1) * limit;
    const where = tabFilter(tab, asmId);
    const order = queueSortOrder(sort, tabOrder(tab));
    const search = extraFilters({ q, filters, visitStatus, visitOutcome });

    const rows = await db.execute<AsmQueueRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.final_intent_score,
            dl.lead_status,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            dl.asm_id,
            asm.name AS asm_name,
            dl.last_touchpoint_at,
            dl.assigned_at,
            lv.visit_status,
            lv.visit_outcome,
            lv.scheduled_date::text AS scheduled_date,
            lv.actual_visit_date::text AS actual_visit_date,
            dl.closed_at
        FROM dealer_leads dl
        ${LATEST_VISIT_JOIN}
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        WHERE ${where} ${search}
        ${order}
        LIMIT ${limit} OFFSET ${offset}
    `);
    return rows as unknown as AsmQueueRow[];
}

export async function countAsmQueueRows({
    tab,
    asmId,
    q,
    filters,
    visitStatus,
    visitOutcome,
}: Pick<
    BuildArgs,
    "tab" | "asmId" | "q" | "filters" | "visitStatus" | "visitOutcome"
>): Promise<number> {
    const where = tabFilter(tab, asmId);
    const search = extraFilters({ q, filters, visitStatus, visitOutcome });
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${where} ${search}
    `);
    return Number(rows[0]?.c ?? 0);
}

/**
 * Badge counts for all four tabs in one round trip.
 *
 * The filters are threaded through for the same reason the Inside Sales badges
 * take them: a badge reading "My Active Visits 3" above a table filtered down to
 * nothing reads as a broken screen rather than as a filter doing its job. The
 * search box stays excluded — pre-existing behaviour on both queues.
 */
export async function fetchAllAsmTabCounts(
    asmId: string,
    opts?: Pick<BuildArgs, "filters" | "visitStatus" | "visitOutcome">,
): Promise<Record<AsmQueueTab, number>> {
    const extra = extraFilters({
        filters: opts?.filters,
        visitStatus: opts?.visitStatus,
        visitOutcome: opts?.visitOutcome,
    });
    const rows = await db.execute<{
        my_visits: string;
        today: string;
        territory: string;
        my_closed: string;
    }>(sql`
        SELECT
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("my_visits", asmId)} ${extra}) AS my_visits,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("today", asmId)} ${extra}) AS today,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("territory", asmId)} ${extra}) AS territory,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("my_closed", asmId)} ${extra}) AS my_closed
    `);
    const r = rows[0]!;
    return {
        my_visits: Number(r.my_visits ?? 0),
        today: Number(r.today ?? 0),
        territory: Number(r.territory ?? 0),
        my_closed: Number(r.my_closed ?? 0),
    };
}

/**
 * The states and cities this ASM's queue actually spans, per tab.
 *
 * Feeds the region selects. Deliberately NOT narrowed by the other filters: a
 * dropdown that removes the option you are about to pick as you pick it is
 * unusable, and it would cost a DISTINCT scan per keystroke to do it. The
 * lateral is joined because tabFilter("today", ...) reads `lv`, and a WHERE that
 * names a missing alias fails at parse time rather than returning nothing.
 */
export async function fetchAsmQueueRegions(
    asmId: string,
    tab: AsmQueueTab,
): Promise<QueueRegion[]> {
    const rows = await db.execute<{ state: string | null; city: string | null }>(
        regionFacetQuery(tabFilter(tab, asmId), LATEST_VISIT_JOIN),
    );
    return foldRegionFacets(
        rows as unknown as { state: string | null; city: string | null }[],
    );
}
