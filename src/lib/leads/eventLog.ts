/**
 * The per-lead event log (review R-21, sheet 9, Requirements #34 and #44):
 * one row per thing that HAPPENED to a lead, filtered by the EVENT's date —
 * "what changed on these leads last week" — not by when the lead was created.
 *
 * Event types (sheet 9 §B) and their sources:
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
};

export type EventLogRow = {
    event_at: string;
    lead_id: string;
    dealer: string | null;
    city: string | null;
    state: string | null;
    business_type: string | null;
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
        UNION ALL
        SELECT fc.changed_at, fc.dealer_lead_id, 'Log detail change',
               fc.old_value, fc.new_value, fc.changed_by, NULL, fc.field, NULL, NULL
          FROM dealer_lead_field_changes fc
         WHERE ${inRange(sql`fc.changed_at`, f)}`
        : sql``;

    return sql`
        SELECT h.changed_at AS event_at, h.dealer_lead_id AS lead_id, 'Status change' AS event_type,
               h.from_status AS from_value,
               h.to_status || COALESCE(' (' || h.to_lost_reason || ')', '') AS to_value,
               h.changed_by AS actor, NULL::text AS channel, NULL::text AS outcome,
               NULL::int AS duration_sec, h.reason_notes AS remarks
          FROM dealer_lead_status_history h
         WHERE ${inRange(sql`h.changed_at`, f)}
        UNION ALL
        SELECT t.performed_at, t.dealer_lead_id, 'Owner change',
               fu.name, tu.name, t.performed_by, t.touchpoint_type, NULL, NULL, t.remarks
          FROM lead_touchpoints t
          LEFT JOIN users fu ON fu.id::text = to_jsonb(t) ->> 'from_owner_id'
          LEFT JOIN users tu ON tu.id::text = to_jsonb(t) ->> 'to_owner_id'
         WHERE (to_jsonb(t) ->> 'from_owner_id' IS NOT NULL OR to_jsonb(t) ->> 'to_owner_id' IS NOT NULL)
           AND ${inRange(sql`t.performed_at`, f)}
        UNION ALL
        ${interest}
        UNION ALL
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
         WHERE t.touchpoint_type IN ('inside_sales_call', 'ai_call')
           AND ${inRange(sql`t.performed_at`, f)}
        UNION ALL
        SELECT COALESCE(v.actual_visit_date::timestamp AT TIME ZONE 'Asia/Kolkata', v.created_at),
               v.dealer_lead_id, 'Visit', NULL, v.visit_status, v.asm_id, v.meeting_mode,
               v.visit_outcome || CASE WHEN v.gps_check_in_lat IS NOT NULL THEN ' · GPS Y' ELSE ' · GPS N' END,
               NULL, v.visit_remarks
          FROM lead_visits v
         WHERE ${inRange(sql`COALESCE(v.actual_visit_date::timestamp AT TIME ZONE 'Asia/Kolkata', v.created_at)`, f)}
        UNION ALL
        SELECT c.created_at, c.dealer_lead_id,
               CASE WHEN c.event_type IN ${QUOTE_EVENTS} THEN 'Quote requested'
                    ELSE 'Commercials: ' || replace(c.event_type, '_', ' ') END,
               NULL, 'v' || c.version_no || COALESCE(' · ₹' || c.price_quoted::text, ''),
               c.created_by, NULL, NULL, NULL, c.deal_notes
          FROM dealer_lead_commercials c
         WHERE ${inRange(sql`c.created_at`, f)}
        UNION ALL
        SELECT c.approved_at, c.dealer_lead_id,
               CASE WHEN c.approval_status = 'rejected' THEN 'Quote rejected' ELSE 'Quote approved' END,
               NULL, 'v' || c.version_no || COALESCE(' · ₹' || c.price_quoted::text, ''),
               c.approved_by, c.approval_mode, c.approval_status, NULL, c.rejection_reason
          FROM dealer_lead_commercials c
         WHERE c.event_type IN ${QUOTE_EVENTS}
           AND c.approval_status IN ('approved', 'rejected')
           AND c.approved_at IS NOT NULL
           AND ${inRange(sql`c.approved_at`, f)}
        UNION ALL
        SELECT d.created_at, d.dealer_lead_id, 'Quote sent', NULL, d.recipient,
               d.sent_by, d.channel, d.status, NULL, d.error
          FROM quotation_dispatches d
         WHERE ${inRange(sql`d.created_at`, f)}
        UNION ALL
        SELECT t.performed_at, t.dealer_lead_id, 'Quote dealer decision', NULL,
               CASE WHEN t.touchpoint_type = 'quote_dealer_approved' THEN 'accepted' ELSE 'declined' END,
               t.performed_by, NULL, NULL, NULL, t.remarks
          FROM lead_touchpoints t
         WHERE t.touchpoint_type IN ('quote_dealer_approved', 'quote_dealer_declined')
           AND ${inRange(sql`t.performed_at`, f)}
        UNION ALL
        SELECT e.raised_at, e.dealer_lead_id, 'Escalation raised', NULL, e.urgency,
               e.raised_by, NULL, e.escalation_reason, NULL, e.escalation_notes
          FROM lead_escalations e
         WHERE ${inRange(sql`e.raised_at`, f)}
        UNION ALL
        SELECT e.ceo_recommended_at, e.dealer_lead_id, 'Escalation CEO comment', NULL,
               e.ceo_recommendation, NULL, NULL, NULL, NULL, e.ceo_comment
          FROM lead_escalations e
         WHERE e.ceo_recommended_at IS NOT NULL AND ${inRange(sql`e.ceo_recommended_at`, f)}
        UNION ALL
        SELECT e.resolved_at, e.dealer_lead_id, 'Escalation resolved', NULL, e.resolution_action,
               e.resolved_by, NULL, NULL, NULL, e.resolution_notes
          FROM lead_escalations e
         WHERE e.resolved_at IS NOT NULL AND ${inRange(sql`e.resolved_at`, f)}
        ${fieldChanges}
    `;
}

function scope(f: EventLogFilters): SQL {
    const parts: SQL[] = [];
    if (f.leadIds?.length) {
        parts.push(sql`ev.lead_id IN (${sql.join(f.leadIds.map((i) => sql`${i}`), sql`, `)})`);
    }
    if (f.performerId) parts.push(sql`ev.actor = ${f.performerId}`);
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
