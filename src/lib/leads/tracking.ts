/**
 * Lead Tracking — the read model behind the "Lead tracking" panel and the
 * single/bulk CSV (E-295).
 *
 * buildLeadTracking(ids) answers, per lead: where has it travelled (the chain
 * of holders), how long did each person hold it, what did everyone do while
 * holding it, and where does it stand now. Same three tables as the touchpoint
 * workbook (src/lib/leads/touchpointWorkbook.ts) — dealer_leads,
 * lead_touchpoints, dealer_lead_status_history — plus one users lookup, all
 * batched with `IN ${ids}` so 5,000 leads cost four round trips, not 20,000.
 *
 * The ownership columns are read through `to_jsonb(t) ->> '…'` because they
 * are not in the Drizzle object (schema.ts header) — on a host without E-295
 * the lookups yield NULL and every hop degrades to "Not recorded" instead of
 * failing the query at parse time.
 *
 * Durations are measured against the DATABASE clock (`now()` from the lead
 * query), never Node's — the two are not guaranteed to agree.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { TOUCHPOINT_TYPE_LABEL, humanise } from "@/lib/lifecycle/touchpointLabels";
import {
    attachEvents,
    deriveEpisodes,
    isHop,
    type HopInput,
} from "./trackingEpisodes";
import {
    SYSTEM_PERSON,
    UNASSIGNED_PERSON,
    type LeadTracking,
    type TrackingEvent,
    type TrackingPerson,
} from "./trackingTypes";

/**
 * Same cap as the touchpoint workbook: the caller caps LEADS at 5,000, nothing
 * caps EVENTS, and the tail is dropped with `truncated: true` rather than
 * silently — a short export must never read like a complete one.
 */
const ROW_CAP = 100_000;

/** Postgres timestamptz → unambiguous UTC ISO text for the client. */
const ISO = (col: ReturnType<typeof sql>) =>
    sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

type LeadRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    source: string | null;
    lead_status: string | null;
    current_owner_id: string | null;
    asm_id: string | null;
    created_at: string;
    assigned_at: string | null;
    updated_at: string | null;
    closed_at: string | null;
    status_since: string | null;
    now_at: string;
};

type TouchpointRow = {
    lead_id: string;
    touchpoint_type: string;
    performed_by: string | null;
    performed_at: string;
    call_status: string | null;
    call_duration_sec: number | null;
    remarks: string | null;
    next_action: string | null;
    external_agent_name: string | null;
    from_owner_id: string | null;
    to_owner_id: string | null;
    /** Non-null iff the E-295 columns exist AND at least one was written. */
    ownership_recorded: boolean | null;
};

type StatusRow = {
    lead_id: string;
    from_status: string | null;
    to_status: string | null;
    changed_by: string | null;
    changed_at: string;
    to_lost_reason: string | null;
    reason_notes: string | null;
};

type UserRow = { id: string; name: string | null; role: string | null };

const statusText = (v: string | null) => humanise(v, LEAD_STATUS_LABEL);

export async function buildLeadTracking(
    leadIds: string[],
): Promise<Map<string, LeadTracking>> {
    const out = new Map<string, LeadTracking>();
    if (leadIds.length === 0) return out;
    const ids = leadIds;
    const fetchCap = ROW_CAP + 1;

    // `IN ${ids}` — drizzle expands a JS array into a row constructor. Never
    // `= ANY(array)`: that form is broken in this codebase.
    const [leadRes, tpRes, shRes] = await Promise.all([
        db.execute<LeadRow>(sql`
            SELECT dl.id, dl.dealer_name, dl.shop_name, dl.phone, dl.city, dl.state,
                   dl.source, dl.lead_status, dl.current_owner_id, dl.asm_id,
                   ${ISO(sql`dl.created_at`)}  AS created_at,
                   ${ISO(sql`dl.assigned_at`)} AS assigned_at,
                   ${ISO(sql`dl.updated_at`)}  AS updated_at,
                   ${ISO(sql`dl.closed_at`)}   AS closed_at,
                   (SELECT ${ISO(sql`MAX(h.changed_at)`)}
                      FROM dealer_lead_status_history h
                     WHERE h.dealer_lead_id = dl.id) AS status_since,
                   ${ISO(sql`now()`)} AS now_at
              FROM dealer_leads dl
             WHERE dl.id IN ${ids}
        `),
        db.execute<TouchpointRow>(sql`
            SELECT t.dealer_lead_id AS lead_id,
                   t.touchpoint_type,
                   t.performed_by,
                   ${ISO(sql`t.performed_at`)} AS performed_at,
                   t.call_status,
                   t.call_duration_sec,
                   t.remarks,
                   t.next_action,
                   to_jsonb(t) ->> 'external_agent_name' AS external_agent_name,
                   to_jsonb(t) ->> 'from_owner_id' AS from_owner_id,
                   to_jsonb(t) ->> 'to_owner_id'   AS to_owner_id,
                   ((to_jsonb(t) ->> 'from_owner_id') IS NOT NULL
                     OR (to_jsonb(t) ->> 'to_owner_id') IS NOT NULL) AS ownership_recorded
              FROM lead_touchpoints t
             WHERE t.dealer_lead_id IN ${ids}
             ORDER BY t.performed_at ASC, t.created_at ASC
             LIMIT ${fetchCap}
        `),
        db.execute<StatusRow>(sql`
            SELECT h.dealer_lead_id AS lead_id,
                   h.from_status, h.to_status, h.changed_by,
                   ${ISO(sql`h.changed_at`)} AS changed_at,
                   h.to_lost_reason, h.reason_notes
              FROM dealer_lead_status_history h
             WHERE h.dealer_lead_id IN ${ids}
             ORDER BY h.changed_at ASC, h.created_at ASC
             LIMIT ${fetchCap}
        `),
    ]);

    const leadRows = leadRes as unknown as LeadRow[];
    const allTp = tpRes as unknown as TouchpointRow[];
    const allSh = shRes as unknown as StatusRow[];
    const truncated = allTp.length > ROW_CAP || allSh.length > ROW_CAP;
    const tpRows = allTp.slice(0, ROW_CAP);
    const shRows = allSh.slice(0, ROW_CAP);

    // One users lookup for every id that appears anywhere — performers,
    // recipients, previous holders, current owner, ASM, status changers.
    const personIds = new Set<string>();
    for (const l of leadRows) {
        if (l.current_owner_id) personIds.add(l.current_owner_id);
        if (l.asm_id) personIds.add(l.asm_id);
    }
    for (const t of tpRows) {
        if (t.performed_by) personIds.add(t.performed_by);
        if (t.from_owner_id) personIds.add(t.from_owner_id);
        if (t.to_owner_id) personIds.add(t.to_owner_id);
    }
    for (const h of shRows) if (h.changed_by) personIds.add(h.changed_by);
    personIds.delete("system");

    const people = new Map<string, TrackingPerson>();
    if (personIds.size > 0) {
        const userRows = (await db.execute<UserRow>(sql`
            SELECT id::text AS id, name, role FROM users
             WHERE id::text IN ${[...personIds]}
        `)) as unknown as UserRow[];
        for (const u of userRows) {
            people.set(u.id, { id: u.id, name: u.name ?? u.id, role: u.role });
        }
    }
    const resolve = (id: string | null): TrackingPerson => {
        if (!id) return UNASSIGNED_PERSON;
        if (id === "system") return SYSTEM_PERSON;
        return people.get(id) ?? { id, name: "Former user", role: null };
    };
    const actorOf = (id: string | null, externalName: string | null): TrackingPerson => {
        if (!id) {
            return externalName
                ? { id: null, name: externalName, role: "external" }
                : SYSTEM_PERSON;
        }
        return resolve(id);
    };

    // Group the event rows by lead.
    const tpByLead = new Map<string, TouchpointRow[]>();
    for (const t of tpRows) {
        const list = tpByLead.get(t.lead_id) ?? [];
        list.push(t);
        tpByLead.set(t.lead_id, list);
    }
    const shByLead = new Map<string, StatusRow[]>();
    for (const h of shRows) {
        const list = shByLead.get(h.lead_id) ?? [];
        list.push(h);
        shByLead.set(h.lead_id, list);
    }

    for (const lead of leadRows) {
        const now = lead.now_at;
        const tps = tpByLead.get(lead.id) ?? [];
        const shs = shByLead.get(lead.id) ?? [];

        const hops: HopInput[] = tps
            .filter((t) => isHop(t))
            .map((t) => ({
                at: t.performed_at,
                touchpoint_type: t.touchpoint_type,
                from_owner_id: t.from_owner_id,
                to_owner_id: t.to_owner_id,
                recorded: t.ownership_recorded === true,
                actor: actorOf(t.performed_by, t.external_agent_name),
                remarks: t.remarks,
                label: humanise(t.touchpoint_type, TOUCHPOINT_TYPE_LABEL),
            }));

        const episodes = deriveEpisodes(
            {
                id: lead.id,
                created_at: lead.created_at,
                assigned_at: lead.assigned_at,
                updated_at: lead.updated_at,
                current_owner_id: lead.current_owner_id,
            },
            hops,
            resolve,
            now,
        );

        const events: TrackingEvent[] = [
            ...tps.map<TrackingEvent>((t) => ({
                at: t.performed_at,
                actor: actorOf(t.performed_by, t.external_agent_name),
                kind: "touchpoint",
                action: humanise(t.touchpoint_type, TOUCHPOINT_TYPE_LABEL),
                type_code: t.touchpoint_type,
                details: t.remarks,
                status_from: null,
                status_to: null,
                call_status: t.call_status,
                duration_sec: t.call_duration_sec,
                next_action: t.next_action,
                to_person:
                    t.ownership_recorded === true
                        ? t.to_owner_id
                            ? resolve(t.to_owner_id)
                            : UNASSIGNED_PERSON
                        : null,
                episode_seq: 0,
            })),
            ...shs.map<TrackingEvent>((h) => ({
                at: h.changed_at,
                actor: resolve(h.changed_by),
                kind: "status_change",
                action: `Status: ${statusText(h.from_status)} → ${statusText(h.to_status)}`,
                type_code: h.to_status ? `status:${h.to_status}` : "status",
                details:
                    [h.reason_notes, h.to_lost_reason ? `Lost reason: ${h.to_lost_reason.replace(/_/g, " ")}` : null]
                        .filter(Boolean)
                        .join(" · ") || null,
                status_from: h.from_status,
                status_to: h.to_status,
                call_status: null,
                duration_sec: null,
                next_action: null,
                to_person: null,
                episode_seq: 0,
            })),
        ].sort((a, b) => {
            const d = Date.parse(a.at) - Date.parse(b.at);
            if (d !== 0) return d;
            // Same instant: the touchpoint (the act) before its status change.
            return a.kind === b.kind ? 0 : a.kind === "touchpoint" ? -1 : 1;
        });

        // The first status-history row's from_status is the best evidence of
        // where the lead started; otherwise assume the pool.
        const initialStatus =
            shs[0]?.from_status ?? (shs.length === 0 ? lead.lead_status : null);
        attachEvents(episodes, events, initialStatus);

        const live = episodes[episodes.length - 1]!;
        const sec = (from: string | null) =>
            from ? Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 1000)) : 0;

        out.set(lead.id, {
            lead: {
                id: lead.id,
                dealer_name: lead.dealer_name,
                shop_name: lead.shop_name,
                phone: lead.phone,
                city: lead.city,
                state: lead.state,
                source: lead.source,
                created_at: lead.created_at,
                closed_at: lead.closed_at,
                lead_status: lead.lead_status,
                current_owner: resolve(lead.current_owner_id),
                asm: lead.asm_id ? resolve(lead.asm_id) : null,
                age_sec: sec(lead.created_at),
                time_in_status_sec: sec(lead.status_since ?? lead.created_at),
                time_with_owner_sec: live.duration_sec,
                handoffs: episodes.length - 1,
            },
            episodes,
            events,
            truncated,
            as_of: now,
        });
    }

    return out;
}

/**
 * The own-only scope for inside_sales_rep / asm (LEAD_TRACKING_OWN_ONLY_ROLES):
 * a lead is theirs when they hold it now, are its ASM, originated it, or were
 * the RECIPIENT of any recorded hand-off — "anyone who ever held it". A
 * pre-E-295 hop whose recipient was never written cannot grant access; that is
 * the backfill's honest limit, not a bug.
 */
export async function canViewLeadTracking(
    userId: string,
    leadId: string,
): Promise<boolean> {
    const rows = (await db.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
            SELECT 1 FROM dealer_leads dl
             WHERE dl.id = ${leadId}
               AND (dl.current_owner_id = ${userId}
                    OR dl.asm_id = ${userId}
                    OR dl.originator_id = ${userId})
        ) OR EXISTS (
            SELECT 1 FROM lead_touchpoints t
             WHERE t.dealer_lead_id = ${leadId}
               AND ((to_jsonb(t) ->> 'to_owner_id') = ${userId}
                    OR (t.touchpoint_type = 'lead_claimed' AND t.performed_by = ${userId}))
        ) AS ok
    `)) as unknown as { ok: boolean }[];
    return rows[0]?.ok === true;
}
