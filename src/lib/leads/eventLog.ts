/**
 * The per-lead event log (review R-21, sheet 9, Requirements #34 and #44):
 * one row per thing that HAPPENED to a lead, filtered by the EVENT's date —
 * "what changed on these leads last week" — not by when the lead was created.
 *
 * Event types (sheet 9 §B) and their sources — the list and its filter
 * values live in eventTypes.ts (tracker ID 34: "Event type" filter):
 *   Lead created         dealer_leads.created_at, every lead (ID 35); who /
 *                        how from the "lead_created" line when there is one
 *   Re-inquiry           lead_touchpoints lead_reinquiry (ID 81)
 *   Sales-ready          lead_touchpoints sales_ready (ID 82, E-314 reason)
 *   Contactability change  lead_touchpoints contactability_flag (ID 36):
 *                        dead number / non-responsive / cleared / repaired
 *   Status change        dealer_lead_status_history (from → to, lost reason)
 *   Owner change         lead_touchpoints with from/to_owner_id (E-295)
 *   Interest change      dealer_lead_interest_history (E-304 trigger — every
 *                        change, whoever made it); older manual changes from
 *                        interest_level_overrides, never counted twice
 *   Call / Call (AI)     lead_touchpoints; outcome = L1 connect status · L2
 *                        bucket · L3 disposition (E-236), else call status
 *   Visit                lead_visits (status, outcome, GPS captured Y/N)
 *   Quote requested      dealer_lead_commercials quote_issue / quote_revision
 *   Quote approved / Quote rejected   the CEO decision on those rows
 *   Quote sent           quotation_dispatches
 *   Quote dealer decision  lead_touchpoints quote_dealer_approved / _declined
 *   Commercials …        other commercials events (brochure, terms)
 *   Escalation raised / CEO comment / resolved   lead_escalations
 *   Log detail change    dealer_lead_field_changes (E-304 trigger — field,
 *                        old → new)
 *
 * E-304 tables are read only when they exist, so the export still works on a
 * host without them (interest changes then come from overrides alone, and
 * there are no log-detail rows).
 *
 * All times are converted to IST in SQL. Capped at EVENT_LOG_ROW_CAP; the
 * route refuses above it rather than truncating silently.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { humanCall } from "@/lib/reports/metricDefinitions";
import { eventTypeMatchers, type LeadEventTypeValue } from "@/lib/leads/eventTypes";

export const EVENT_LOG_ROW_CAP = 50_000;

/** Keep in step with the `cols` array in drizzle/E-304_lead_interest_history_field_audit.sql. */
export const AUDITED_LEAD_FIELDS = [
    "dealer_name", "shop_name", "phone", "language", "location", "state",
    "city", "area", "pincode", "gstin", "contact_email", "business_type",
    "segments", "address_notes", "next_follow_up_at", "preliminary_payment_intent",
] as const;

export type EventLogFilters = {
    /** Inclusive IST dates, YYYY-MM-DD. */
    from: string;
    to: string;
    /** Only these leads (one lead or a selection). Absent = every lead. */
    leadIds?: string[];
    /** Only events performed by this user. */
    performerId?: string;
    /** Only these event types (eventTypes.ts values, ID 34). Absent = every type. */
    eventTypes?: string[];
};

export type EventLogRow = {
    event_at: string;
    lead_id: string;
    dealer: string | null;
    city: string | null;
    state: string | null;
    business_type: string | null;
    /** When the lead became sales-ready (E-314); NULL when it never did. */
    sales_ready_at?: string | null;
    event_type: string;
    from_value: string | null;
    to_value: string | null;
    performed_by: string | null;
    role: string | null;
    channel: string | null;
    outcome: string | null;
    duration_sec: number | null;
    remarks: string | null;
};

type Sources = { interestHistory: boolean; fieldChanges: boolean };

async function sources(): Promise<Sources> {
    const r = (await db.execute(sql`
        SELECT to_regclass('public.dealer_lead_interest_history') IS NOT NULL AS ih,
               to_regclass('public.dealer_lead_field_changes') IS NOT NULL AS fc
    `)) as unknown as Array<{ ih: boolean; fc: boolean }>;
    return { interestHistory: Boolean(r[0]?.ih), fieldChanges: Boolean(r[0]?.fc) };
}

/** `ts` inside [from, to] as IST calendar days. */
const inRange = (ts: SQL, f: EventLogFilters) =>
    sql`(${ts} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date`;

const QUOTE_EVENTS = sql`('quote_issue', 'quote_revision')`;

function eventsUnion(f: EventLogFilters, s: Sources): SQL {
    // Interest: the E-304 history when present, plus any manual override that
    // has no history row within a few seconds of it (i.e. made before E-304).
    const interest = s.interestHistory
        ? sql`
        SELECT ih.changed_at, ih.dealer_lead_id, 'Interest change',
               ih.from_level, ih.to_level, COALESCE(ih.changed_by, o.changed_by),
               NULL, NULL, NULL, o.reason
          FROM dealer_lead_interest_history ih
          LEFT JOIN LATERAL (
              SELECT ov.changed_by, ov.reason FROM interest_level_overrides ov
               WHERE ov.dealer_lead_id = ih.dealer_lead_id
                 AND ov.changed_at BETWEEN ih.changed_at - INTERVAL '5 seconds' AND ih.changed_at + INTERVAL '5 seconds'
               LIMIT 1) o ON TRUE
         WHERE ${inRange(sql`ih.changed_at`, f)}
        UNION ALL
        SELECT o.changed_at, o.dealer_lead_id, 'Interest change',
               o.from_value, o.to_value, o.changed_by, NULL, NULL, NULL, o.reason
          FROM interest_level_overrides o
         WHERE ${inRange(sql`o.changed_at`, f)}
           AND NOT EXISTS (
               SELECT 1 FROM dealer_lead_interest_history ih
                WHERE ih.dealer_lead_id = o.dealer_lead_id
                  AND ih.changed_at BETWEEN o.changed_at - INTERVAL '5 seconds' AND o.changed_at + INTERVAL '5 seconds')`
        : sql`
        SELECT o.changed_at, o.dealer_lead_id, 'Interest change',
               o.from_value, o.to_value, o.changed_by, NULL, NULL, NULL, o.reason
          FROM interest_level_overrides o
         WHERE ${inRange(sql`o.changed_at`, f)}`;

    const fieldChanges = s.fieldChanges
        ? sql`
        SELECT fc.changed_at, fc.dealer_lead_id, 'Log detail change',
               fc.old_value, fc.new_value, fc.changed_by, NULL, fc.field, NULL, NULL
          FROM dealer_lead_field_changes fc
         WHERE ${inRange(sql`fc.changed_at`, f)}`
        : null;

    // Each source, tagged with the event types (eventTypes.ts values) it can
    // produce: a source none of whose types were asked for is not run at all.
    // Columns: event_at, lead_id, event_type, from_value, to_value, actor,
    // channel, outcome, duration_sec, remarks — names and types come from SEED.
    const branches: Array<{ types: LeadEventTypeValue[]; sql: SQL | null }> = [
        {
            // ID 35 — every lead, dated at creation (created_at has no time
            // zone and is stored as UTC). Who / how from the "Lead created"
            // line when one was written (ID 81 onwards), else the originator.
            types: ["lead_created"],
            sql: sql`
        SELECT dl.created_at AT TIME ZONE 'UTC', dl.id, 'Lead created',
               NULL, replace(COALESCE(to_jsonb(dl) ->> 'source_door', dl.source), '_', ' '),
               COALESCE(lc.performed_by, dl.originator_id),
               dl.source, replace(to_jsonb(dl) ->> 'source_origin', '_', ' '), NULL, lc.remarks
          FROM dealer_leads dl
          LEFT JOIN LATERAL (
              SELECT t.performed_by, t.remarks FROM lead_touchpoints t
               WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'lead_created'
               ORDER BY t.performed_at LIMIT 1) lc ON TRUE
         WHERE dl.created_at IS NOT NULL
           AND ${inRange(sql`(dl.created_at AT TIME ZONE 'UTC')`, f)}`,
        },
        {
            // ID 81 — a known dealer arriving again (leadSource.ts writeReinquiry
            // / recordReinquiries). The remark says through which door.
            types: ["re_inquiry"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id, 'Re-inquiry', NULL, NULL,
               t.performed_by, t.sync_method, NULL, NULL, t.remarks
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'lead_reinquiry'
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        {
            // ID 82 — the dated Sales-ready event (salesReady.ts markSalesReady,
            // and the backfill, both write this line). The reason is the
            // lead's sales_ready_reason (E-314, read tolerantly).
            types: ["sales_ready"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id, 'Sales-ready', NULL,
               replace(to_jsonb(dl) ->> 'sales_ready_reason', '_', ' '),
               t.performed_by, t.sync_method, NULL, NULL, t.remarks
          FROM lead_touchpoints t
          LEFT JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'sales_ready'
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        {
            // ID 36 — contactability set / cleared / repaired (contactability.ts).
            // Only the remark records which change it was, so To is read from
            // the remark's fixed opening words.
            types: ["contactability"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id, 'Contactability change', NULL,
               CASE WHEN t.remarks LIKE 'Dead number%'                THEN 'Dead number'
                    WHEN t.remarks LIKE 'Non-responsive%'             THEN 'Non-responsive'
                    WHEN t.remarks LIKE 'Contactability cleared%'     THEN 'Cleared (call connected)'
                    WHEN t.remarks LIKE 'Number repaired%'            THEN 'Cleared (number repaired)'
                    WHEN t.remarks LIKE 'Number confirmed as is%'     THEN 'Dead number (confirmed as is)'
                    ELSE NULL END,
               t.performed_by, t.sync_method, NULL, NULL, t.remarks
          FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'contactability_flag'
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        {
            types: ["status_change"],
            sql: sql`
        SELECT h.changed_at, h.dealer_lead_id, 'Status change',
               h.from_status,
               h.to_status || COALESCE(' (' || h.to_lost_reason || ')', ''),
               h.changed_by, NULL, NULL, NULL, h.reason_notes
          FROM dealer_lead_status_history h
         WHERE ${inRange(sql`h.changed_at`, f)}`,
        },
        {
            types: ["owner_change"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id, 'Owner change',
               fu.name, tu.name, t.performed_by, t.touchpoint_type, NULL, NULL, t.remarks
          FROM lead_touchpoints t
          LEFT JOIN users fu ON fu.id::text = to_jsonb(t) ->> 'from_owner_id'
          LEFT JOIN users tu ON tu.id::text = to_jsonb(t) ->> 'to_owner_id'
         WHERE (to_jsonb(t) ->> 'from_owner_id' IS NOT NULL OR to_jsonb(t) ->> 'to_owner_id' IS NOT NULL)
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        { types: ["interest_change"], sql: interest },
        {
            types: ["call", "call_ai"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id,
               CASE WHEN t.touchpoint_type = 'ai_call' THEN 'Call (AI)' ELSE 'Call' END,
               NULL, NULL, t.performed_by,
               COALESCE(t.external_system, 'crm'),
               -- L1 · L2 · L3 when the call carries a disposition (E-236).
               COALESCE(
                   NULLIF(concat_ws(' · ', to_jsonb(t) ->> 'connect_status',
                                            to_jsonb(t) ->> 'disposition_bucket',
                                            to_jsonb(t) ->> 'disposition'), ''),
                   t.call_status),
               t.call_duration_sec, t.remarks
          FROM lead_touchpoints t
         -- A human call counted once (humanCall): a NeoDove call the agent
         -- re-dispositioned within minutes is one call, not two events.
         WHERE (t.touchpoint_type = 'ai_call' OR ${humanCall(sql`t`)})
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        {
            types: ["visit"],
            sql: sql`
        SELECT COALESCE(v.actual_visit_date::timestamp AT TIME ZONE 'Asia/Kolkata', v.created_at),
               v.dealer_lead_id, 'Visit', NULL, v.visit_status, v.asm_id, v.meeting_mode,
               v.visit_outcome || CASE WHEN v.gps_check_in_lat IS NOT NULL THEN ' · GPS Y' ELSE ' · GPS N' END,
               NULL, v.visit_remarks
          FROM lead_visits v
         WHERE ${inRange(sql`COALESCE(v.actual_visit_date::timestamp AT TIME ZONE 'Asia/Kolkata', v.created_at)`, f)}`,
        },
        {
            types: ["quote_requested", "commercials"],
            sql: sql`
        SELECT c.created_at, c.dealer_lead_id,
               CASE WHEN c.event_type IN ${QUOTE_EVENTS} THEN 'Quote requested'
                    ELSE 'Commercials: ' || replace(c.event_type, '_', ' ') END,
               NULL, 'v' || c.version_no || COALESCE(' · ₹' || c.price_quoted::text, ''),
               c.created_by, NULL, NULL, NULL, c.deal_notes
          FROM dealer_lead_commercials c
         WHERE ${inRange(sql`c.created_at`, f)}`,
        },
        {
            types: ["quote_approved", "quote_rejected"],
            sql: sql`
        SELECT c.approved_at, c.dealer_lead_id,
               CASE WHEN c.approval_status = 'rejected' THEN 'Quote rejected' ELSE 'Quote approved' END,
               NULL, 'v' || c.version_no || COALESCE(' · ₹' || c.price_quoted::text, ''),
               c.approved_by, c.approval_mode, c.approval_status, NULL, c.rejection_reason
          FROM dealer_lead_commercials c
         WHERE c.event_type IN ${QUOTE_EVENTS}
           AND c.approval_status IN ('approved', 'rejected')
           AND c.approved_at IS NOT NULL
           AND ${inRange(sql`c.approved_at`, f)}`,
        },
        {
            types: ["quote_sent", "quote_send_failed"],
            sql: sql`
        SELECT d.created_at, d.dealer_lead_id,
               -- Only a dispatch that went through is "sent"; a failed one is its own event.
               CASE WHEN d.status = 'sent' THEN 'Quote sent' ELSE 'Quote send failed' END,
               NULL, d.recipient,
               d.sent_by, d.channel, d.status, NULL, d.error
          FROM quotation_dispatches d
         WHERE ${inRange(sql`d.created_at`, f)}`,
        },
        {
            types: ["quote_dealer_decision"],
            sql: sql`
        SELECT t.performed_at, t.dealer_lead_id, 'Quote dealer decision', NULL,
               CASE WHEN t.touchpoint_type = 'quote_dealer_approved' THEN 'accepted' ELSE 'declined' END,
               t.performed_by, NULL, NULL, NULL, t.remarks
          FROM lead_touchpoints t
         WHERE t.touchpoint_type IN ('quote_dealer_approved', 'quote_dealer_declined')
           AND ${inRange(sql`t.performed_at`, f)}`,
        },
        {
            types: ["escalation_raised"],
            sql: sql`
        SELECT e.raised_at, e.dealer_lead_id, 'Escalation raised', NULL, e.urgency,
               e.raised_by, NULL, e.escalation_reason, NULL, e.escalation_notes
          FROM lead_escalations e
         WHERE ${inRange(sql`e.raised_at`, f)}`,
        },
        {
            types: ["escalation_ceo_comment"],
            sql: sql`
        SELECT e.ceo_recommended_at, e.dealer_lead_id, 'Escalation CEO comment', NULL,
               e.ceo_recommendation, NULL, NULL, NULL, NULL, e.ceo_comment
          FROM lead_escalations e
         WHERE e.ceo_recommended_at IS NOT NULL AND ${inRange(sql`e.ceo_recommended_at`, f)}`,
        },
        {
            types: ["escalation_resolved"],
            sql: sql`
        SELECT e.resolved_at, e.dealer_lead_id, 'Escalation resolved', NULL, e.resolution_action,
               e.resolved_by, NULL, NULL, NULL, e.resolution_notes
          FROM lead_escalations e
         WHERE e.resolved_at IS NOT NULL AND ${inRange(sql`e.resolved_at`, f)}`,
        },
        { types: ["log_detail_change"], sql: fieldChanges },
    ];

    const wanted = f.eventTypes?.length ? new Set<string>(f.eventTypes) : null;
    const chosen = branches.filter((b) => b.sql && (!wanted || b.types.some((t) => wanted.has(t))));
    // SEED fixes the column names and types and returns nothing, so the union
    // is valid whichever sources were skipped.
    return sql.join([SEED, ...chosen.map((b) => b.sql as SQL)], sql`
        UNION ALL
`);
}

const SEED = sql`
        SELECT NULL::timestamptz AS event_at, NULL::text AS lead_id, NULL::text AS event_type,
               NULL::text AS from_value, NULL::text AS to_value, NULL::text AS actor,
               NULL::text AS channel, NULL::text AS outcome, NULL::int AS duration_sec,
               NULL::text AS remarks
         WHERE FALSE`;

function scope(f: EventLogFilters): SQL {
    const parts: SQL[] = [];
    if (f.leadIds?.length) {
        parts.push(sql`ev.lead_id IN (${sql.join(f.leadIds.map((i) => sql`${i}`), sql`, `)})`);
    }
    if (f.performerId) parts.push(sql`ev.actor = ${f.performerId}`);
    // ID 34 — a source can yield several types (Call / Call (AI)), so the
    // chosen types are also matched on the row itself.
    if (f.eventTypes?.length) {
        const { exact, prefixes } = eventTypeMatchers(f.eventTypes);
        const ors: SQL[] = [];
        if (exact.length) ors.push(sql`ev.event_type IN (${sql.join(exact.map((l) => sql`${l}`), sql`, `)})`);
        for (const p of prefixes) ors.push(sql`ev.event_type LIKE ${`${p}%`}`);
        if (ors.length) parts.push(sql`(${sql.join(ors, sql` OR `)})`);
    }
    return parts.length ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
}

export async function countEvents(f: EventLogFilters): Promise<number> {
    const s = await sources();
    const r = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM (${eventsUnion(f, s)}) ev ${scope(f)}
    `)) as unknown as Array<{ n: number }>;
    return Number(r[0]?.n ?? 0);
}

export async function fetchEvents(f: EventLogFilters): Promise<EventLogRow[]> {
    const s = await sources();
    const rows = (await db.execute(sql`
        SELECT (ev.event_at AT TIME ZONE 'Asia/Kolkata')::text AS event_at,
               ev.lead_id,
               COALESCE(dl.shop_name, dl.dealer_name)   AS dealer,
               dl.city, dl.state,
               to_jsonb(dl) ->> 'business_type'         AS business_type,
               to_jsonb(dl) ->> 'sales_ready_at'        AS sales_ready_at,
               ev.event_type, ev.from_value, ev.to_value,
               COALESCE(u.name, ev.actor)               AS performed_by,
               u.role, ev.channel, ev.outcome, ev.duration_sec, ev.remarks
          FROM (${eventsUnion(f, s)}) ev
          LEFT JOIN dealer_leads dl ON dl.id = ev.lead_id
          LEFT JOIN users u ON u.id::text = ev.actor
          ${scope(f)}
         ORDER BY ev.event_at DESC
         LIMIT ${EVENT_LOG_ROW_CAP}::int
    `)) as unknown as EventLogRow[];
    return rows;
}

/** Whether this host records interest history and field edits (E-304). */
export async function eventSources(): Promise<Sources> {
    return sources();
}

export type EventSummaryRow = {
    person: string;
    status_changes: number;
    log_detail_changes: number;
    owner_changes: number;
    interest_changes: number;
    calls: number;
    visits_logged: number;
    new_visits: number;
    quotes_requested: number;
    quotes_approved: number;
    quotes_rejected: number;
};

/**
 * Sheet 9 §C — counts per person on the same filter. Approvals and rejections
 * are counted per person who REQUESTED the quote (the SPOC whose quotes they
 * were), not per approver — the question is how that SPOC's quotes fared.
 */
export async function summarizeEvents(f: EventLogFilters): Promise<EventSummaryRow[]> {
    const s = await sources();
    const rows = (await db.execute(sql`
        WITH ev AS (SELECT * FROM (${eventsUnion(f, s)}) ev ${scope(f)}),
        first_visit AS (
            SELECT dealer_lead_id, MIN(COALESCE(actual_visit_date::timestamp AT TIME ZONE 'Asia/Kolkata', created_at)) AS at
              FROM lead_visits GROUP BY dealer_lead_id
        ),
        decisions AS (
            SELECT COALESCE(c.created_by, '') AS k,
                   COUNT(*) FILTER (WHERE c.approval_status = 'approved') AS approved,
                   COUNT(*) FILTER (WHERE c.approval_status = 'rejected') AS rejected
              FROM dealer_lead_commercials c
             WHERE c.event_type IN ${QUOTE_EVENTS}
               AND c.approved_at IS NOT NULL
               AND ${inRange(sql`c.approved_at`, f)}
               ${f.leadIds?.length ? sql`AND c.dealer_lead_id IN (${sql.join(f.leadIds.map((i) => sql`${i}`), sql`, `)})` : sql``}
             GROUP BY 1
        ),
        per AS (
            SELECT COALESCE(ev.actor, '') AS k,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Status change')        AS status_changes,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Log detail change')    AS log_detail_changes,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Owner change')         AS owner_changes,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Interest change')      AS interest_changes,
                   COUNT(*) FILTER (WHERE ev.event_type LIKE 'Call%')             AS calls,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Visit')                AS visits_logged,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Visit' AND fv.at = ev.event_at) AS new_visits,
                   COUNT(*) FILTER (WHERE ev.event_type = 'Quote requested')      AS quotes_requested
              FROM ev
              LEFT JOIN first_visit fv ON fv.dealer_lead_id = ev.lead_id AND ev.event_type = 'Visit'
             GROUP BY 1
        )
        -- '' stands for "no actor recorded", so a plain equality join works
        -- (Postgres cannot FULL JOIN on IS NOT DISTINCT FROM).
        SELECT COALESCE(u.name, NULLIF(COALESCE(p.k, d.k), ''), '(not recorded)') AS person,
               COALESCE(p.status_changes, 0)::int     AS status_changes,
               COALESCE(p.log_detail_changes, 0)::int AS log_detail_changes,
               COALESCE(p.owner_changes, 0)::int      AS owner_changes,
               COALESCE(p.interest_changes, 0)::int   AS interest_changes,
               COALESCE(p.calls, 0)::int              AS calls,
               COALESCE(p.visits_logged, 0)::int      AS visits_logged,
               COALESCE(p.new_visits, 0)::int         AS new_visits,
               COALESCE(p.quotes_requested, 0)::int   AS quotes_requested,
               COALESCE(d.approved, 0)::int           AS quotes_approved,
               COALESCE(d.rejected, 0)::int           AS quotes_rejected
          FROM per p
          FULL OUTER JOIN decisions d ON d.k = p.k
          LEFT JOIN users u ON u.id::text = COALESCE(p.k, d.k)
         ORDER BY 1
    `)) as unknown as EventSummaryRow[];
    return rows;
}
