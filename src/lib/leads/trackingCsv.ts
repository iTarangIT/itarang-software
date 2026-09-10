/**
 * Lead Tracking → CSV (E-295). One file for one lead or for five thousand.
 *
 * ONE ROW PER LINE ITEM, two shapes told apart by the leading `Row Type`:
 *
 *   HOLD    one per ownership episode — who held the lead, from when to when,
 *           for how long, who handed it over and why, how many things happened
 *           while they held it. This is the "how much time in each user's
 *           hands" answer, readable without a pivot.
 *   ACTION  one per event — what was done, by whom (and in what role), while
 *           whom was holding it, with the status before/after when it was a
 *           status change.
 *
 * Rows are grouped by lead and run OLDEST FIRST inside a lead: a journey is
 * read top-down (Unassigned → Nidhi → ASM Ganesh), unlike the activity
 * timeline on screen which is newest-first. The lead's headline columns repeat
 * on every row so Excel's filter and pivot keep working — the same reasoning
 * as src/lib/leads/touchpointWorkbook.ts.
 *
 * Conventions (BOM, CRLF, IST `YYYY-MM-DD HH:mm`, the X-Export-* headers) come
 * from src/lib/leads/queueCsv.ts so this opens exactly like every other lead
 * export.
 */

import {
    csvDateTime,
    csvPretty,
    csvResponse,
    type CsvColumn,
} from "@/lib/leads/queueCsv";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { CALL_STATUS_LABEL, NEXT_ACTION_LABEL, humanise } from "@/lib/lifecycle/touchpointLabels";
import { fmtDuration, prettyRole, type LeadTracking } from "./trackingTypes";

export type TrackingCsvRow = {
    row_type: "HOLD" | "ACTION";
    // ── lead headline (repeated on every row) ──
    lead_id: string;
    dealer: string;
    shop: string;
    phone: string;
    city: string;
    state: string;
    source: string;
    created_at: string;
    current_status: string;
    current_owner: string;
    current_owner_role: string;
    asm: string;
    lead_age: string;
    time_in_status: string;
    time_with_owner: string;
    handoffs: number;
    // ── HOLD block ──
    seq: number;
    holder: string;
    holder_role: string;
    held_from: string;
    held_until: string;
    held_for: string;
    handed_by: string;
    handed_by_role: string;
    handoff_type: string;
    handoff_reason: string;
    status_at_start: string;
    status_at_end: string;
    actions_in_hold: number | string;
    approximate: string;
    // ── ACTION block ──
    action_at: string;
    actor: string;
    actor_role: string;
    holder_at_time: string;
    action: string;
    details: string;
    status_before: string;
    status_after: string;
    call_status: string;
    duration_sec: number | string;
    next_action: string;
    handed_to: string;
    type_code: string;
};

const statusText = (v: string | null) => (v ? humanise(v, LEAD_STATUS_LABEL) : "");

/** The header contract — exported so the verifier asserts it, not a copy. */
export const TRACKING_CSV_COLUMNS: CsvColumn<TrackingCsvRow>[] = [
    { header: "Row Type", value: (r) => r.row_type },
    { header: "Lead ID", value: (r) => r.lead_id },
    { header: "Dealer", value: (r) => r.dealer },
    { header: "Shop", value: (r) => r.shop },
    { header: "Phone", value: (r) => r.phone },
    { header: "City", value: (r) => r.city },
    { header: "State", value: (r) => r.state },
    { header: "Source", value: (r) => r.source },
    { header: "Created (IST)", value: (r) => r.created_at },
    { header: "Current Status", value: (r) => r.current_status },
    { header: "Current Owner", value: (r) => r.current_owner },
    { header: "Current Owner Role", value: (r) => r.current_owner_role },
    { header: "ASM", value: (r) => r.asm },
    { header: "Lead Age", value: (r) => r.lead_age },
    { header: "Time In Current Status", value: (r) => r.time_in_status },
    { header: "Time With Current Owner", value: (r) => r.time_with_owner },
    { header: "Handoffs", value: (r) => String(r.handoffs) },
    { header: "Seq", value: (r) => String(r.seq) },
    { header: "Holder", value: (r) => r.holder },
    { header: "Holder Role", value: (r) => r.holder_role },
    { header: "Held From (IST)", value: (r) => r.held_from },
    { header: "Held Until (IST)", value: (r) => r.held_until },
    { header: "Held For", value: (r) => r.held_for },
    { header: "Handed By", value: (r) => r.handed_by },
    { header: "Handed By Role", value: (r) => r.handed_by_role },
    { header: "Handoff Type", value: (r) => r.handoff_type },
    { header: "Handoff Reason", value: (r) => r.handoff_reason },
    { header: "Status At Start", value: (r) => r.status_at_start },
    { header: "Status At End", value: (r) => r.status_at_end },
    { header: "Actions In Hold", value: (r) => String(r.actions_in_hold) },
    { header: "Approximate", value: (r) => r.approximate },
    { header: "Action At (IST)", value: (r) => r.action_at },
    { header: "Actor", value: (r) => r.actor },
    { header: "Actor Role", value: (r) => r.actor_role },
    { header: "Holder At The Time", value: (r) => r.holder_at_time },
    { header: "Action", value: (r) => r.action },
    { header: "Details", value: (r) => r.details },
    { header: "Status Before", value: (r) => r.status_before },
    { header: "Status After", value: (r) => r.status_after },
    { header: "Call Status", value: (r) => r.call_status },
    { header: "Duration (sec)", value: (r) => String(r.duration_sec) },
    { header: "Next Action", value: (r) => r.next_action },
    { header: "Handed To", value: (r) => r.handed_to },
    { header: "Type (code)", value: (r) => r.type_code },
];

const EMPTY_HOLD = {
    seq: "" as unknown as number,
    holder: "",
    holder_role: "",
    held_from: "",
    held_until: "",
    held_for: "",
    handed_by: "",
    handed_by_role: "",
    handoff_type: "",
    handoff_reason: "",
    status_at_start: "",
    status_at_end: "",
    actions_in_hold: "",
    approximate: "",
};

const EMPTY_ACTION = {
    action_at: "",
    actor: "",
    actor_role: "",
    holder_at_time: "",
    action: "",
    details: "",
    status_before: "",
    status_after: "",
    call_status: "",
    duration_sec: "",
    next_action: "",
    handed_to: "",
    type_code: "",
};

/**
 * Flatten trackings into rows. Order: the trackings as given (the caller
 * decides lead order), each lead's HOLD rows then its ACTION rows, oldest
 * first. Every lead yields at least one HOLD row (episode 0 always exists),
 * so "I exported 40 leads" always means 40 leads are in the file.
 */
export function buildTrackingCsvRows(trackings: LeadTracking[]): TrackingCsvRow[] {
    const rows: TrackingCsvRow[] = [];
    for (const t of trackings) {
        const L = t.lead;
        const head = {
            lead_id: L.id,
            dealer: L.dealer_name ?? "",
            shop: L.shop_name ?? "",
            phone: L.phone ?? "",
            city: L.city ?? "",
            state: L.state ?? "",
            source: csvPretty(L.source),
            created_at: csvDateTime(L.created_at),
            current_status: statusText(L.lead_status),
            current_owner: L.current_owner.name,
            current_owner_role: prettyRole(L.current_owner.role),
            asm: L.asm?.name ?? "",
            lead_age: fmtDuration(L.age_sec),
            time_in_status: fmtDuration(L.time_in_status_sec),
            time_with_owner: fmtDuration(L.time_with_owner_sec),
            handoffs: L.handoffs,
        };
        const holderOf = (seq: number) => t.episodes[seq]?.holder.name ?? "";

        for (const e of t.episodes) {
            rows.push({
                row_type: "HOLD",
                ...head,
                ...EMPTY_ACTION,
                seq: e.seq,
                holder: e.holder.name,
                holder_role: prettyRole(e.holder.role),
                held_from: csvDateTime(e.from_at),
                held_until: e.to_at ? csvDateTime(e.to_at) : "(still holding)",
                held_for: fmtDuration(e.duration_sec),
                handed_by: e.handed_by?.name ?? "",
                handed_by_role: prettyRole(e.handed_by?.role),
                handoff_type: e.handoff_label ?? "",
                handoff_reason: e.handoff_reason ?? "",
                status_at_start: statusText(e.status_at_start),
                status_at_end: statusText(e.status_at_end),
                actions_in_hold: e.actions_count,
                approximate: e.approximate ? "Yes" : "No",
            });
        }
        for (const ev of t.events) {
            rows.push({
                row_type: "ACTION",
                ...head,
                ...EMPTY_HOLD,
                action_at: csvDateTime(ev.at),
                actor: ev.actor.name,
                actor_role: prettyRole(ev.actor.role),
                holder_at_time: holderOf(ev.episode_seq),
                action: ev.action,
                details: ev.details ?? "",
                status_before: statusText(ev.status_from),
                status_after: statusText(ev.status_to),
                call_status: ev.call_status ? humanise(ev.call_status, CALL_STATUS_LABEL) : "",
                duration_sec: ev.duration_sec ?? "",
                next_action: ev.next_action ? humanise(ev.next_action, NEXT_ACTION_LABEL) : "",
                handed_to: ev.to_person?.name ?? "",
                type_code: ev.type_code,
            });
        }
    }
    return rows;
}

/** The download itself — shared by the single-lead GET and the bulk POST. */
export function trackingCsvResponse(
    trackings: LeadTracking[],
    filename: string,
): Response {
    const rows = buildTrackingCsvRows(trackings);
    return csvResponse({
        rows,
        columns: TRACKING_CSV_COLUMNS,
        filename,
        total: rows.length,
    });
}
