/**
 * A lead's phone-call history (NeoDove task, 26 Nov — "the call history shows
 * when calls happened and their relevant status"). Server only.
 *
 * One row per human call on the lead (lead_touchpoints, type
 * inside_sales_call): calls a rep logged in the CRM and every call NeoDove
 * sent (one row per NeoDove message). For a NeoDove call the row is filled from
 * the ORIGINAL message the webhook stored (neodove_sync_events.request_payload,
 * matched on external_event_id) and parsed by the same parseInboundEvent the
 * webhook uses — so past calls get their status name, stage, outcome and
 * NeoDove follow-up date too, without rewriting a single stored row.
 *
 * AI-dialer calls stay on the "AI calls" tab (transcripts, intent).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { parseInboundEvent } from "@/lib/neodove/mapper";
import { neodoveStatusLabel, readableNeodoveRemarks } from "@/lib/neodove/statusCodes";
import { touchpointRecordingLink } from "@/lib/ai/storage/recordingLinks";

export type LeadCall = {
    id: string;
    /** When the call happened (NeoDove's own call time for NeoDove calls). ISO. */
    at: string;
    source: "neodove" | "crm";
    /** Who made it: the CRM user, else the NeoDove agent's name. */
    by: string | null;
    /** by is a NeoDove agent with no CRM login linked. */
    by_external: boolean;
    /** connected / not_connected / … as stored on the call; null when unknown. */
    call_status: string | null;
    connected: boolean | null;
    /** NeoDove's status name (sent, or from the code table), else "NeoDove code N". */
    status: string | null;
    status_code: string | null;
    stage: string | null;
    /** NeoDove's outcome tag (lead_tag_name). */
    outcome: string | null;
    /** NeoDove's follow-up date. ISO. */
    follow_up_at: string | null;
    duration_sec: number | null;
    recording_url: string | null;
    campaign: string | null;
    /** What the caller typed (NeoDove dispose remarks, or the CRM call note). */
    note: string | null;
    /** The stored line, readable, for anything above that is missing. */
    remarks: string | null;
};

const LIMIT = 300;

async function hasLedger(): Promise<boolean> {
    const r = (await db.execute(sql`SELECT to_regclass('public.neodove_sync_events') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return Boolean(r[0]?.ok);
}

export async function loadLeadCalls(leadId: string): Promise<{ calls: LeadCall[]; truncated: boolean }> {
    const ledger = await hasLedger();
    const rows = (await db.execute(sql`
        SELECT t.touchpoint_id::text AS id, t.performed_at, t.call_status, t.call_duration_sec, t.remarks,
               t.external_system, t.external_event_id,
               to_jsonb(t) ->> 'external_agent_name' AS external_agent_name,
               to_jsonb(t) ->> 'recording_url' AS recording_url,
               u.name AS performed_by_name,
               ${ledger
                   ? sql`(SELECT ev.request_payload FROM neodove_sync_events ev
                           WHERE t.external_system = 'neodove' AND ev.direction = 'inbound'
                             AND ev.external_event_id = t.external_event_id
                           ORDER BY ev.created_at LIMIT 1)`
                   : sql`NULL::jsonb`} AS payload
          FROM lead_touchpoints t
          LEFT JOIN users u ON u.id::text = t.performed_by::text
         WHERE t.dealer_lead_id = ${leadId}
           AND t.touchpoint_type = 'inside_sales_call'
         ORDER BY t.performed_at DESC NULLS LAST, t.touchpoint_id DESC
         LIMIT ${LIMIT + 1}
    `)) as unknown as Array<{
        id: string;
        performed_at: string | Date | null;
        call_status: string | null;
        call_duration_sec: number | null;
        remarks: string | null;
        external_system: string | null;
        external_event_id: string | null;
        external_agent_name: string | null;
        recording_url: string | null;
        performed_by_name: string | null;
        payload: unknown;
    }>;

    const calls = rows.slice(0, LIMIT).map((r): LeadCall => {
        const neodove = r.external_system === "neodove";
        const ev = neodove && r.payload && typeof r.payload === "object" ? safeParse(r.payload) : null;
        const callStatus = r.call_status ?? null;
        const connected =
            callStatus === "connected" ? true : callStatus ? false : ev?.callConnected ?? null;
        return {
            id: r.id,
            at: r.performed_at ? new Date(r.performed_at).toISOString() : "",
            source: neodove ? "neodove" : "crm",
            by: r.performed_by_name ?? r.external_agent_name ?? ev?.agentName ?? null,
            by_external: !r.performed_by_name && Boolean(r.external_agent_name ?? ev?.agentName),
            call_status: callStatus,
            connected,
            status: ev ? neodoveStatusLabel(ev.dispositionCode, ev.disposition) : null,
            status_code: ev?.dispositionCode ?? null,
            stage: ev?.stage ?? null,
            outcome: ev?.tag ?? null,
            follow_up_at: ev?.followUpAt ? ev.followUpAt.toISOString() : null,
            duration_sec: r.call_duration_sec ?? ev?.callDurationSec ?? null,
            recording_url: touchpointRecordingLink(r.id, r.recording_url),
            campaign: ev?.campaignName ?? null,
            note: neodove ? (ev?.remarks ?? null) : r.remarks,
            remarks: readableNeodoveRemarks(r.remarks),
        };
    });
    return { calls, truncated: rows.length > LIMIT };
}

function safeParse(payload: unknown) {
    try {
        return parseInboundEvent(payload);
    } catch {
        return null;
    }
}
