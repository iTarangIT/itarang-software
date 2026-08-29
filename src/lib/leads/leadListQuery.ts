// Raw-SQL builder for the merged "Leads" list (/leads → Leads tab).
//
// Supersedes src/lib/admin/leadsInfoQuery.ts, which served the old
// /admin/leads-info page. Those were two screens over the same `dealer_leads`
// table: /leads filtered `phone IS NOT NULL` and showed `current_status`, while
// Leads Info filtered `is_active IS NOT FALSE` and showed `lead_status` — so the
// SAME lead read "New" on one and "— no status" on the other. This module is the
// single query behind the merged screen, so that can't happen again.
//
// Follows the pattern of src/lib/asm/queryBuilder.ts and
// src/lib/admin/listQueries.ts (raw sql`` fragments, db.execute).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";
import { INTENT_BUCKETS, type IntentBucket } from "@/lib/leads/intentBucket";
import { NEODOVE_LINKED_SYNC_STATUSES } from "@/lib/neodove/syncStatus";
import type { CampaignFacet } from "@/lib/leads/leadCampaign";
// Value import, so it must come from the dependency-free module — this file
// pulls in `db` and can never be reachable from a client component.
import { CAMPAIGN_NONE } from "@/lib/leads/campaign";

// Shared with the API route. Both ends of a created-at range must look like a
// calendar date before it goes near SQL.
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type LeadListRow = {
    // ── oversight half (was Leads Info) ──
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    source: string | null;
    final_intent_score: number | null;
    interest_level: string | null;
    current_owner_id: string | null;
    current_owner_name: string | null;
    current_owner_role: string | null;
    asm_id: string | null;
    asm_name: string | null;
    last_touchpoint_at: string | null;
    assigned_at: string | null;
    created_at: string | null;
    visit_status: string | null;
    visit_outcome: string | null;
    // ── action half (was /leads) — what the row actions and dialer read ──
    current_status: string | null;
    location: string | null;
    next_call_at: string | null;
    total_attempts: number | null;
    follow_up_history: unknown;
    // neodove_sync_status is NOT here on purpose — see the note in the API route.
};

export type LeadListFilters = {
    /** lead_status pipeline stage, or the UNASSIGNED_FILTER sentinel. */
    status?: string | null;
    ownerId?: string | null;
    asmId?: string | null;
    source?: string | null;
    /**
     * Only leads that are with the NeoDove calling team (E-224 sync state), NOT
     * `source = 'neodove'` — see the note on LeadFilters.neodove.
     */
    neodoveOnly?: boolean;
    state?: string | null;
    city?: string | null;
    search?: string | null;
    /** Display bucket over final_intent_score. See intentBucket.ts. */
    intent?: IntentBucket | null;
    /**
     * Explicit inclusive score range — the same axis as `intent`, expressed
     * exactly rather than in bands.
     *
     * The UI keeps these mutually exclusive with `intent` because a bucket IS a
     * score range: holding both is either redundant ("Hot" + 75–100) or a
     * contradiction ("Hot" + 0–30) that returns nothing and reads as a broken
     * filter. They are still ANDed here, so a hand-built URL carrying both gets
     * the honest intersection rather than one silently winning.
     */
    scoreMin?: number | null;
    scoreMax?: number | null;
    /** created_at calendar-date range, inclusive both ends (YYYY-MM-DD). */
    from?: string | null;
    to?: string | null;
    // ── Call disposition (E-236) ─────────────────────────────────────────
    // The three levels are ANDed independently rather than resolved to one
    // predicate: the UI narrows them, but each is a legitimate question on its
    // own ("everything Not Connected", "everything we lost").
    /** L1 — 'connected' | 'not_connected'. */
    connectStatus?: string | null;
    /** L2 — Cold | Warm | Hot | Converted | Lost. */
    dispositionBucket?: string | null;
    /** L3 — the disposition label, exact match. */
    disposition?: string | null;
    // ── Idle age ─────────────────────────────────────────────────────────
    // Inclusive day bounds over the SAME basis the Idle column displays —
    // COALESCE(last_touchpoint_at, created_at). Matching that basis is not
    // cosmetic: filtering on last_touchpoint_at alone would exclude the 2,440
    // never-touched leads that the column shows as 85d, and a filter that
    // disagrees with the number on screen is indistinguishable from a bug.
    idleMinDays?: number | null;
    idleMaxDays?: number | null;
    /** Only leads with no touchpoint at all. */
    idleNeverTouched?: boolean;
    // ── Campaign ─────────────────────────────────────────────────────────
    /** A campaign id from either system, or CAMPAIGN_NONE for "not in one". */
    campaign?: string | null;
    /**
     * Whether the NeoDove tables exist here. Passed in rather than probed
     * because buildWhere is synchronous and a missing RELATION fails at parse
     * time — see neodoveTablesPresent().
     */
    hasNeodoveTables?: boolean;
    // ── AI call state + signals ──────────────────────────────────────────
    // Read through a LATERAL onto the LATEST ai_call_logs row, NEVER through the
    // dealer_leads rollups: intent_band is populated on 4 of 3,941 rows and
    // info_signals_count on 2, so a rollup-backed filter would return a handful
    // of leads and read as a bug rather than as an answer.
    /** Qualified | Warm | Cold | Disqualified — the latest call's band. */
    aiBand?: string | null;
    /** At least N of the five info signals disclosed on the latest call. */
    signalsMin?: number | null;
    /** connected | attempted | never. */
    aiCalled?: string | null;
    /**
     * The dealer asked to be called back — from EITHER system, because a rep
     * asking "who wants a callback" does not care who recorded it.
     */
    callback?: boolean;
};

export type LeadListFacets = {
    owners: { id: string; name: string | null; role: string | null }[];
    asms: { id: string; name: string | null }[];
    sources: string[];
    /** Dispositions actually present in the data — including values NeoDove
     *  sent that are outside the CC sheet, which are filterable too. */
    dispositions: {
        value: string;
        bucket: string | null;
        connect_status: string | null;
    }[];
    /**
     * Campaigns with at least one lead, both systems. Populated by the API
     * route from fetchCampaignFacets() — it lives in leadCampaign.ts because
     * the NeoDove half must be allowed to fail independently, which this
     * module's single-statement facets query cannot express.
     */
    campaigns?: CampaignFacet[];
    /**
     * How far the AI dialer has actually got.
     *
     * The filter group renders these as its denominator and as a count beside
     * every option, and disables any option that would match zero. That is the
     * single most effective anti-"looks broken" move here: on database-1 only
     * 119 of 3,941 leads have ever been dialled and 27 calls produced signals,
     * so most of these filters legitimately match almost nothing — and nobody
     * can select a filter that cannot match.
     */
    aiSignals?: {
        totalLeads: number;
        leadsCalled: number;
        leadsConnected: number;
        leadsCallback: number;
        band: Record<string, number>;
    };
};

export type LeadListStats = {
    total: number;
    hot: number;
    warm: number;
    cold: number;
    unassigned: number;
    scheduled: number;
};

// Latest lead_visits row per lead — drives the visit_status / visit_outcome
// column. LATERAL keeps it to one row even when a lead has several visits.
// ⚠ to_jsonb, not a bare column reference — same reasoning as the E-236 note in
// buildWhere, taken one step further. E-236's columns are read only when their
// filter is set, so a database without the migration keeps serving the list to
// everyone who doesn't use them. That is not enough here: the four call sites
// this predicate reaches include the CSV export and the "select all N matching"
// id query, and a parse-time failure in any of them is a 500 on a database that
// simply has no NeoDove leads. Reading through to_jsonb makes that case an empty
// result, which is the truth there.
const NEODOVE_STATUS = sql`to_jsonb(dl) ->> 'neodove_sync_status'`;
const NEODOVE_LINKED_LIST = sql.raw(
    NEODOVE_LINKED_SYNC_STATUSES.map((s) => `'${s}'`).join(", "),
);

// The age basis, identical to the Idle column's (see idleDays()).
const IDLE_BASIS = sql`COALESCE(dl.last_touchpoint_at, dl.created_at)`;

/**
 * Membership predicates for the campaign filter.
 *
 * The NeoDove half is emitted only when `hasNeodoveTables` — omitted entirely,
 * not guarded at runtime, because naming an absent relation fails at PARSE time.
 * The dialer half needs no guard: dialer_campaigns is in schema.ts and predates
 * this feature everywhere.
 */
function inDialerCampaign(campaignId: string) {
    return sql`EXISTS (
        SELECT 1 FROM dialer_campaign_leads dcl
         WHERE dcl.lead_id = dl.id AND dcl.campaign_id = ${campaignId}
    )`;
}

function inNeodoveCampaign(campaignId: string) {
    // Same push_status cut as the Campaign column: a refused or deduped push
    // never reached the campaign, so those leads are not IN it.
    return sql`EXISTS (
        SELECT 1 FROM neodove_lead_links nll
         WHERE nll.dealer_lead_id = dl.id
           AND nll.neodove_campaign_id = ${campaignId}
           AND nll.push_status IN ('pushed', 'pending')
    )`;
}

function inAnyDialerCampaign() {
    return sql`EXISTS (SELECT 1 FROM dialer_campaign_leads dcl WHERE dcl.lead_id = dl.id)`;
}

function inAnyNeodoveCampaign() {
    return sql`EXISTS (
        SELECT 1 FROM neodove_lead_links nll
         WHERE nll.dealer_lead_id = dl.id
           AND nll.push_status IN ('pushed', 'pending')
    )`;
}

const LATEST_VISIT_JOIN = sql`
    LEFT JOIN LATERAL (
        SELECT visit_status, visit_outcome
        FROM lead_visits
        WHERE dealer_lead_id = dl.id
        ORDER BY COALESCE(actual_visit_date, scheduled_date, created_at) DESC
        LIMIT 1
    ) lv ON true
`;

// Intent-bucket predicates. COALESCE matters: final_intent_score is nullable and
// never-called leads are the majority — without it they'd fall out of every
// bucket and the three stat cards wouldn't sum to Total.
function intentPredicate(bucket: IntentBucket) {
    const score = sql`COALESCE(dl.final_intent_score, 0)`;
    if (bucket === "hot") return sql`${score} >= ${INTENT_BUCKETS.HOT_MIN}`;
    if (bucket === "warm")
        return sql`${score} BETWEEN ${INTENT_BUCKETS.WARM_MIN} AND ${INTENT_BUCKETS.HOT_MIN - 1}`;
    return sql`${score} <= ${INTENT_BUCKETS.WARM_MIN - 1}`;
}

/**
 * The whole intent-score selection — bucket AND explicit range — as one
 * predicate, or TRUE when neither is set.
 *
 * Both live here rather than beside the other filters because both are cuts
 * through the SAME column, and the stats query has to be able to lift the two of
 * them together (see ignoreIntent).
 */
function intentSelection(f: LeadListFilters) {
    const score = sql`COALESCE(dl.final_intent_score, 0)`;
    const parts = [];
    if (f.intent) parts.push(intentPredicate(f.intent));
    // Inclusive at both ends: "0 to 30" must admit a lead scoring exactly 30,
    // which matters here because computeBand.ts emits the band constants
    // 0/30/60/90 rather than a continuous score — an exclusive bound would drop
    // an entire band.
    if (typeof f.scoreMin === "number") parts.push(sql`${score} >= ${f.scoreMin}`);
    if (typeof f.scoreMax === "number") parts.push(sql`${score} <= ${f.scoreMax}`);
    return parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

/**
 * `opts.ignoreIntent` omits the intent-bucket clause AND the explicit score
 * range. Used by the stats query so the Hot/Warm/Cold cards keep showing all
 * three counts while one of them is the active filter — otherwise selecting
 * "Hot" would zero the Warm and Cold cards and the segmented control would
 * destroy itself on first click. The score range is lifted with it for exactly
 * the same reason: typing 75–100 must not blank the Cold card.
 */
/** Is any AI-backed filter set? Drives whether the LATERAL is emitted at all. */
function hasAiFilter(f: LeadListFilters): boolean {
    return Boolean(
        f.aiBand || f.aiCalled || f.callback || typeof f.signalsMin === "number",
    );
}

/**
 * Latest AI call per lead.
 *
 * Emitted ONLY when an AI filter is set, so an unfiltered list produces exactly
 * the SQL it produced before this feature — no new join, no behaviour change,
 * nothing to regress on the hot path.
 */
export function aiSignalsJoin(f: LeadListFilters) {
    if (!hasAiFilter(f)) return sql``;
    return sql`
        LEFT JOIN LATERAL (
            SELECT a.band,
                   a.info_signals_count,
                   a.transcript IS NOT NULL           AS connected,
                   a.signals ->> 'callback_agreed'    AS callback_agreed
              FROM ai_call_logs a
             WHERE a.lead_id = dl.id
             ORDER BY a.created_at DESC
             LIMIT 1
        ) ai ON true`;
}

function buildWhere(f: LeadListFilters, opts?: { ignoreIntent?: boolean }) {
    // Soft-delete aware. This is the merged base predicate: it replaces
    // /leads' old `phone IS NOT NULL` (which also let deleted leads through).
    const conds = [sql`dl.is_active IS NOT FALSE`];

    if (f.status === UNASSIGNED_FILTER) {
        conds.push(sql`dl.current_owner_id IS NULL`);
    } else if (f.status) {
        conds.push(sql`dl.lead_status = ${f.status}`);
    }
    if (f.ownerId) conds.push(sql`dl.current_owner_id = ${f.ownerId}`);
    if (f.asmId) conds.push(sql`dl.asm_id = ${f.asmId}`);
    if (f.source) conds.push(sql`dl.source = ${f.source}`);
    if (f.neodoveOnly) {
        conds.push(sql`${NEODOVE_STATUS} IN (${NEODOVE_LINKED_LIST})`);
    }
    if (f.state) conds.push(sql`dl.state ILIKE ${`%${f.state}%`}`);
    if (f.city) conds.push(sql`dl.city ILIKE ${`%${f.city}%`}`);
    // E-236. Emitted ONLY when the filter is set, which is what lets a database
    // without the migration keep serving this list for everyone who does not use
    // the disposition filter — the columns are not in schema.ts and a bare
    // reference would be a hard "column does not exist".
    if (f.connectStatus) {
        conds.push(sql`dl.last_connect_status = ${f.connectStatus}`);
    }
    if (f.dispositionBucket) {
        conds.push(sql`dl.last_disposition_bucket = ${f.dispositionBucket}`);
    }
    if (f.disposition) {
        conds.push(sql`dl.last_disposition = ${f.disposition}`);
    }
    // ── Idle age ─────────────────────────────────────────────────────────
    // "at least N days idle" = the basis is at or before N days ago. The max
    // bound uses max+1 with a strict > so the band is inclusive at both ends:
    // 30–59 must admit exactly 59 days and exclude exactly 60.
    if (f.idleNeverTouched) {
        conds.push(sql`dl.last_touchpoint_at IS NULL`);
    }
    if (typeof f.idleMinDays === "number") {
        conds.push(
            sql`${IDLE_BASIS} <= NOW() - make_interval(days => ${f.idleMinDays})`,
        );
    }
    if (typeof f.idleMaxDays === "number") {
        conds.push(
            sql`${IDLE_BASIS} > NOW() - make_interval(days => ${f.idleMaxDays + 1})`,
        );
    }

    // ── Campaign ─────────────────────────────────────────────────────────
    if (f.campaign === CAMPAIGN_NONE) {
        const notIn = [sql`NOT ${inAnyDialerCampaign()}`];
        if (f.hasNeodoveTables) notIn.push(sql`NOT ${inAnyNeodoveCampaign()}`);
        conds.push(sql.join(notIn, sql` AND `));
    } else if (f.campaign) {
        // The id is matched against BOTH systems rather than being routed by
        // its shape: ids are opaque strings and guessing the system from a
        // `camp_` / `NDC-` prefix would break the day either convention changes.
        // Only one can ever match — the id spaces do not overlap.
        const anyOf = [inDialerCampaign(f.campaign)];
        if (f.hasNeodoveTables) anyOf.push(inNeodoveCampaign(f.campaign));
        conds.push(sql`(${sql.join(anyOf, sql` OR `)})`);
    }

    // ── AI call state ────────────────────────────────────────────────────
    // `attempted` counts ai_call_logs rows, NEVER dialer_campaign_leads. 1,500
    // leads have been in a campaign and only 119 have a call log — campaign
    // membership means QUEUED, not called, and using it as a proxy would
    // over-report the AI's reach by 12x. The existing "Campaign" filter says
    // in-a-campaign; this one says actually-called, and they must stay distinct.
    if (f.aiCalled === "connected") {
        conds.push(sql`ai.connected IS TRUE`);
    } else if (f.aiCalled === "attempted") {
        conds.push(
            sql`EXISTS (SELECT 1 FROM ai_call_logs a WHERE a.lead_id = dl.id)`,
        );
    } else if (f.aiCalled === "never") {
        conds.push(
            sql`NOT EXISTS (SELECT 1 FROM ai_call_logs a WHERE a.lead_id = dl.id)`,
        );
    }
    if (f.aiBand) conds.push(sql`ai.band = ${f.aiBand}`);
    if (typeof f.signalsMin === "number") {
        conds.push(sql`COALESCE(ai.info_signals_count, 0) >= ${f.signalsMin}`);
    }
    // One filter spanning both systems. The dl.last_disposition disjunct is a
    // migration-gated column, so it is named ONLY inside this predicate — i.e.
    // only when the filter is set — exactly as the E-236 filters above do.
    if (f.callback) {
        conds.push(
            sql`(ai.callback_agreed = 'yes' OR dl.last_disposition = 'As to Call Back')`,
        );
    }

    if (!opts?.ignoreIntent) {
        const selection = intentSelection(f);
        // Skip the no-op TRUE so an unfiltered WHERE stays readable in logs.
        if (f.intent || typeof f.scoreMin === "number" || typeof f.scoreMax === "number") {
            conds.push(selection);
        }
    }
    if (f.from && ISO_DATE_RE.test(f.from)) {
        conds.push(sql`dl.created_at::date >= ${f.from}`);
    }
    if (f.to && ISO_DATE_RE.test(f.to)) {
        conds.push(sql`dl.created_at::date <= ${f.to}`);
    }
    if (f.search) {
        const like = `%${f.search}%`;
        // `location` is included because the old /leads search covered it and
        // the old Leads Info search did not — dropping it would silently break
        // a search people use. It is the legacy free-form region field.
        conds.push(
            sql`(dl.dealer_name ILIKE ${like} OR dl.phone ILIKE ${like} OR dl.shop_name ILIKE ${like} OR dl.location ILIKE ${like})`,
        );
    }
    return sql.join(conds, sql` AND `);
}

/**
 * The list's WHERE clause, for callers outside this module.
 *
 * Exported so GET /api/dealer-leads/export builds its CSV from the SAME
 * predicate the screen does. A second hand-written where-clause is how an
 * export starts quietly disagreeing with the list it claims to be of — the
 * exact divergence that made /leads and /admin/leads-info show the same lead
 * two different ways before they were merged.
 *
 * Assumes the caller aliases dealer_leads as `dl`.
 */
export function buildExportWhere(f: LeadListFilters) {
    return buildWhere(f);
}

export async function fetchLeadListRows(
    f: LeadListFilters,
    page: number,
    limit: number,
): Promise<LeadListRow[]> {
    const offset = (page - 1) * limit;
    const where = buildWhere(f);
    const rows = await db.execute<LeadListRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.lead_status,
            dl.source,
            dl.final_intent_score,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            owner.role AS current_owner_role,
            dl.asm_id,
            asm.name AS asm_name,
            dl.last_touchpoint_at,
            dl.assigned_at,
            dl.created_at,
            lv.visit_status,
            lv.visit_outcome,
            dl.current_status,
            dl.location,
            dl.next_call_at,
            dl.total_attempts,
            dl.follow_up_history
        FROM dealer_leads dl
        ${aiSignalsJoin(f)}
        ${LATEST_VISIT_JOIN}
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        WHERE ${where}
        ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
    `);
    return rows as unknown as LeadListRow[];
}

/**
 * Just the ids matching the current filters, for "select all N matching".
 *
 * The list pages at 10–100 rows, so the header checkbox can only ever reach one
 * page — useless against a few thousand leads when the whole point is a bulk
 * reassign or export. This returns the full matching id set instead.
 *
 * Capped at BULK_ID_CAP because that is the hard limit on `lead_ids` in
 * POST /api/admin/leads/bulk — handing back more ids than the action can accept
 * would let someone select 8,000 leads and get a validation error at the end.
 * The caller compares the returned length against `total` and says so when the
 * selection was truncated.
 */
export const BULK_ID_CAP = 5000;

export async function fetchLeadListIds(
    f: LeadListFilters,
    cap: number = BULK_ID_CAP,
): Promise<string[]> {
    const where = buildWhere(f);
    const rows = await db.execute<{ id: string }>(sql`
        SELECT dl.id
        FROM dealer_leads dl
        ${aiSignalsJoin(f)}
        WHERE ${where}
        ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
        LIMIT ${cap}
    `);
    return (rows as unknown as { id: string }[]).map((r) => r.id);
}

/**
 * Row count AND all five stat cards in one round trip.
 *
 * `total` is computed with the intent filter re-applied via FILTER, so it equals
 * the list's real row count, while hot/warm/cold are computed WITHOUT it (see
 * buildWhere's ignoreIntent). That replaces the old separate count query — one
 * fewer round trip than /api/dealer-leads did before the merge.
 */
export async function fetchLeadListStats(
    f: LeadListFilters,
): Promise<LeadListStats> {
    const where = buildWhere(f, { ignoreIntent: true });
    // Re-applied per aggregate rather than in the WHERE, so `total` matches the
    // list's real row count while the three bucket cards stay computed without
    // it. Covers the explicit range too — otherwise Total would ignore a score
    // filter the list is honouring and the header would contradict the table.
    const inBucket = intentSelection(f);
    const rows = await db.execute<{
        total: string;
        hot: string;
        warm: string;
        cold: string;
        unassigned: string;
        scheduled: string;
    }>(sql`
        SELECT
            COUNT(*) FILTER (WHERE ${inBucket})::text AS total,
            COUNT(*) FILTER (WHERE ${intentPredicate("hot")})::text AS hot,
            COUNT(*) FILTER (WHERE ${intentPredicate("warm")})::text AS warm,
            COUNT(*) FILTER (WHERE ${intentPredicate("cold")})::text AS cold,
            COUNT(*) FILTER (WHERE dl.current_owner_id IS NULL AND ${inBucket})::text AS unassigned,
            COUNT(*) FILTER (WHERE dl.next_call_at IS NOT NULL AND ${inBucket})::text AS scheduled
        FROM dealer_leads dl
        ${aiSignalsJoin(f)}
        WHERE ${where}
    `);
    const r = rows[0] as unknown as Record<string, string> | undefined;
    return {
        total: Number(r?.total ?? 0),
        hot: Number(r?.hot ?? 0),
        warm: Number(r?.warm ?? 0),
        cold: Number(r?.cold ?? 0),
        unassigned: Number(r?.unassigned ?? 0),
        scheduled: Number(r?.scheduled ?? 0),
    };
}

// Distinct owners / ASMs / sources present on active leads — populates the
// filter dropdowns.
export async function fetchLeadListFacets(): Promise<LeadListFacets> {
    const owners = await db.execute<{ id: string; name: string | null; role: string | null }>(sql`
        SELECT DISTINCT u.id::text AS id, u.name, u.role
        FROM users u
        JOIN dealer_leads dl ON dl.current_owner_id = u.id::text
        WHERE dl.is_active IS NOT FALSE
        ORDER BY u.name NULLS LAST
    `);
    const asms = await db.execute<{ id: string; name: string | null }>(sql`
        SELECT DISTINCT u.id::text AS id, u.name
        FROM users u
        JOIN dealer_leads dl ON dl.asm_id = u.id::text
        WHERE dl.is_active IS NOT FALSE
        ORDER BY u.name NULLS LAST
    `);
    const sources = await db.execute<{ source: string }>(sql`
        SELECT DISTINCT source FROM dealer_leads
        WHERE is_active IS NOT FALSE AND source IS NOT NULL
        ORDER BY source
    `);

    // E-236. Its own try/catch and its own statement: the columns are not in
    // schema.ts and a database without the migration must lose the disposition
    // dropdown, not the owner / ASM / source dropdowns beside it.
    //
    // Read from the DATA rather than only from the sheet so a disposition that
    // arrived from a campaign configured with a different vocabulary is still
    // offerable — the UI groups those apart under "Other (seen in NeoDove)".
    let dispositions: LeadListFacets["dispositions"] = [];
    try {
        const rows = await db.execute<{
            value: string;
            bucket: string | null;
            connect_status: string | null;
        }>(sql`
            SELECT DISTINCT
                   last_disposition        AS value,
                   last_disposition_bucket AS bucket,
                   last_connect_status     AS connect_status
              FROM dealer_leads
             WHERE is_active IS NOT FALSE AND last_disposition IS NOT NULL
             ORDER BY value
        `);
        dispositions = rows as unknown as LeadListFacets["dispositions"];
    } catch {
        // E-236 not applied here — the filter offers the sheet's values only.
    }

    // Its own statement and its own try/catch, same discipline as the
    // disposition facets above: a failure here must cost the AI filter group,
    // not the whole filter bar.
    let aiSignals: LeadListFacets["aiSignals"];
    try {
        const rows = await db.execute<{
            total_leads: string;
            leads_called: string;
            leads_connected: string;
            leads_callback: string;
            band_qualified: string;
            band_warm: string;
            band_cold: string;
            band_disqualified: string;
        }>(sql`
            SELECT
                (SELECT COUNT(*)::text FROM dealer_leads WHERE is_active IS NOT FALSE)
                    AS total_leads,
                COUNT(DISTINCT lead_id)::text AS leads_called,
                COUNT(DISTINCT lead_id) FILTER (WHERE transcript IS NOT NULL)::text
                    AS leads_connected,
                COUNT(DISTINCT lead_id) FILTER (WHERE signals ->> 'callback_agreed' = 'yes')::text
                    AS leads_callback,
                COUNT(DISTINCT lead_id) FILTER (WHERE band = 'Qualified')::text
                    AS band_qualified,
                COUNT(DISTINCT lead_id) FILTER (WHERE band = 'Warm')::text
                    AS band_warm,
                COUNT(DISTINCT lead_id) FILTER (WHERE band = 'Cold')::text
                    AS band_cold,
                COUNT(DISTINCT lead_id) FILTER (WHERE band = 'Disqualified')::text
                    AS band_disqualified
              FROM ai_call_logs
        `);
        const r = (rows as unknown as Record<string, string>[])[0];
        if (r) {
            aiSignals = {
                totalLeads: Number(r.total_leads ?? 0),
                leadsCalled: Number(r.leads_called ?? 0),
                leadsConnected: Number(r.leads_connected ?? 0),
                leadsCallback: Number(r.leads_callback ?? 0),
                band: {
                    Qualified: Number(r.band_qualified ?? 0),
                    Warm: Number(r.band_warm ?? 0),
                    Cold: Number(r.band_cold ?? 0),
                    Disqualified: Number(r.band_disqualified ?? 0),
                },
            };
        }
    } catch {
        // No ai_call_logs here — the AI filter group renders without counts.
    }

    return {
        owners: owners as unknown as LeadListFacets["owners"],
        asms: asms as unknown as LeadListFacets["asms"],
        sources: (sources as unknown as { source: string }[]).map((r) => r.source),
        dispositions,
        aiSignals,
    };
}

export { UNASSIGNED_FILTER };
