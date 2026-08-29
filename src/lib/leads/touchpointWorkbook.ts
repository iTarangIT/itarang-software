/**
 * Multi-lead touchpoint-history workbook.
 *
 * The single-lead equivalent lives at
 * src/app/api/inside-sales/lead/[id]/history/export.xlsx/route.ts and produces
 * two sheets for ONE lead. This builds the batch version behind the /leads bulk
 * bar: pick N leads, get one file. Same tables, same joins, same IST rendering —
 * a lead exported both ways must produce identical event rows.
 *
 * ONE SHEET, ONE ROW PER EVENT. It used to be three sheets (Leads /
 * Touchpoints / Status History), each opening with the lead's Dealer / Phone /
 * Shop / City so a flattened row stayed attributable — which meant the same
 * four columns three times over and a reader flipping tabs to line a status
 * change up against the call that caused it. Now the lead's headline columns
 * appear ONCE, filled on every row (so Excel's filter and pivot keep working),
 * followed by one event block that a touchpoint and a status change both fit
 * in: what happened, who did it, when, and what was written about it.
 *
 * Rows are grouped by lead and newest-first within a lead, exactly the order
 * the Activity timeline on screen reads in. A lead with no events at all still
 * gets one row, so "I exported 40 leads" always means 40 leads are in the file.
 */

import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { fmtIst, styleHeader, zebra } from "@/lib/excel/sheetStyle";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import {
    CALL_STATUS_LABEL,
    NEXT_ACTION_LABEL,
    TOUCHPOINT_TYPE_LABEL,
    humanise,
} from "@/lib/lifecycle/touchpointLabels";

/**
 * The caller caps the LEAD count (5,000, same as every other bulk action) but
 * nothing caps the EVENT count, and 5,000 chatty leads is six figures of rows.
 * Each source query stops at this many and the sheet says so in its last row —
 * a silently short export reads exactly like a complete one.
 */
const ROW_CAP = 100_000;

const DASH = "—";

// "History" itself is a name Excel reserves (ExcelJS refuses it), hence the prefix.
export const HISTORY_SHEET_NAME = "Lead History";

/** The header row, exported so the verifier asserts the contract, not a copy. */
export const HISTORY_COLUMNS = [
    "Dealer",
    "Shop",
    "Phone",
    "City",
    "State",
    "Lead Status",
    "Interest",
    "Score",
    "Source",
    "Owner",
    "ASM",
    "Touchpoints",
    "Created (IST)",
    "Event",
    "Activity",
    "By",
    "At (IST)",
    "Details",
    "Call Status",
    "Duration (sec)",
    "Engaged",
    "Next Action",
    "Next Action At (IST)",
    "Lost Reason",
    "Type (code)",
] as const;

/** How many leading columns describe the LEAD (frozen while scrolling). */
export const HISTORY_LEAD_COLUMN_COUNT = 13;

/**
 * The sheet must read like the Activity timeline on screen, not like the table
 * underneath it. A row saying `quote_dispatched` / `Assigned_Not_Contacted` is
 * a database dump; the person opening this file saw "Quote sent to dealer" and
 * "Assigned", and those are the words that have to arrive in Excel.
 *
 * The raw codes are kept in their own trailing column rather than dropped —
 * they are what anyone pivoting or filtering the sheet by machine value needs.
 */
const statusText = (v: string | null | undefined) =>
    humanise(v, LEAD_STATUS_LABEL);

type LeadRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    interest_level: string | null;
    final_intent_score: number | null;
    source: string | null;
    owner_name: string | null;
    asm_name: string | null;
    created_at: string | null;
    touchpoint_count: number | string | null;
};

type TouchpointRow = {
    lead_id: string;
    touchpoint_type: string | null;
    performed_by_name: string | null;
    performed_at: string | null;
    call_status: string | null;
    call_duration_sec: number | null;
    is_engaged: boolean | null;
    remarks: string | null;
    next_action: string | null;
    next_action_at: string | null;
};

type StatusRow = {
    lead_id: string;
    from_status: string | null;
    to_status: string | null;
    changed_by_name: string | null;
    changed_at: string | null;
    to_lost_reason: string | null;
    reason_notes: string | null;
};

/** One line of the merged timeline — a touchpoint or a status change. */
type HistoryEvent = {
    /** ISO-ish timestamp text from Postgres; sorts correctly as a string within one tz. */
    at: string | null;
    cells: {
        event: string;
        activity: string;
        by: string;
        at: string;
        details: string;
        call_status: string;
        duration: number | string;
        engaged: string;
        next_action: string;
        next_action_at: string;
        lost_reason: string;
        type: string;
    };
};

/** Appends a single, visible "this file is incomplete" row. */
function markTruncated(sheet: ExcelJS.Worksheet, cap: number, what: string) {
    const row = sheet.addRow([
        `— ${what} truncated at ${cap.toLocaleString("en-IN")} rows —`,
    ]);
    row.font = { bold: true, color: { argb: "FFB45309" } };
}

const EMPTY_EVENT_CELLS: HistoryEvent["cells"] = {
    event: DASH,
    activity: DASH,
    by: DASH,
    at: DASH,
    details: DASH,
    call_status: DASH,
    duration: DASH,
    engaged: DASH,
    next_action: DASH,
    next_action_at: DASH,
    lost_reason: DASH,
    type: DASH,
};

function touchpointEvent(r: TouchpointRow): HistoryEvent {
    return {
        at: r.performed_at,
        cells: {
            event: "Touchpoint",
            activity: humanise(r.touchpoint_type, TOUCHPOINT_TYPE_LABEL),
            by: r.performed_by_name ?? "System",
            at: fmtIst(r.performed_at),
            details: r.remarks ?? DASH,
            call_status: humanise(r.call_status, CALL_STATUS_LABEL),
            duration: r.call_duration_sec ?? DASH,
            engaged: r.is_engaged == null ? DASH : r.is_engaged ? "Yes" : "No",
            next_action: humanise(r.next_action, NEXT_ACTION_LABEL),
            next_action_at: r.next_action_at ? fmtIst(r.next_action_at) : DASH,
            lost_reason: DASH,
            type: r.touchpoint_type ?? DASH,
        },
    };
}

function statusEvent(r: StatusRow): HistoryEvent {
    return {
        at: r.changed_at,
        cells: {
            event: "Status change",
            activity: `${statusText(r.from_status)} → ${statusText(r.to_status)}`,
            by: r.changed_by_name ?? "System",
            at: fmtIst(r.changed_at),
            details: r.reason_notes ?? DASH,
            call_status: DASH,
            duration: DASH,
            engaged: DASH,
            next_action: DASH,
            next_action_at: DASH,
            lost_reason: r.to_lost_reason
                ? r.to_lost_reason.replace(/_/g, " ")
                : DASH,
            // Raw machine value for the status side, so a pivot on Type (code)
            // separates the two kinds of event without parsing "Activity".
            type: r.to_status ? `status:${r.to_status}` : DASH,
        },
    };
}

export async function buildTouchpointWorkbook(
    leadIds: string[],
): Promise<ExcelJS.Workbook> {
    // `IN ${ids}` — drizzle expands a JS array into a row constructor, which is
    // exactly what IN wants. Do NOT switch this to `= ANY(array)`: that form is
    // broken in this codebase and silently matches nothing.
    const ids = leadIds;

    // One row over the cap, so "did we truncate?" is answerable without a
    // second COUNT query.
    const fetchCap = ROW_CAP + 1;

    const [leadRes, tpRes, shRes] = await Promise.all([
        db.execute<LeadRow>(sql`
            SELECT
                dl.id,
                dl.dealer_name,
                dl.shop_name,
                dl.phone,
                dl.city,
                dl.state,
                dl.lead_status,
                dl.interest_level,
                dl.final_intent_score,
                dl.source,
                ow.name  AS owner_name,
                asm.name AS asm_name,
                dl.created_at::text AS created_at,
                (
                    SELECT COUNT(*)
                    FROM lead_touchpoints t
                    WHERE t.dealer_lead_id = dl.id
                ) AS touchpoint_count
            FROM dealer_leads dl
            LEFT JOIN users ow  ON ow.id::text  = dl.current_owner_id
            LEFT JOIN users asm ON asm.id::text = dl.asm_id
            WHERE dl.id IN ${ids}
            ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
        `),
        db.execute<TouchpointRow>(sql`
            SELECT
                t.dealer_lead_id AS lead_id,
                t.touchpoint_type,
                u.name AS performed_by_name,
                t.performed_at::text AS performed_at,
                t.call_status,
                t.call_duration_sec,
                t.is_engaged,
                t.remarks,
                t.next_action,
                t.next_action_at::text AS next_action_at
            FROM lead_touchpoints t
            LEFT JOIN users u ON u.id::text = t.performed_by
            WHERE t.dealer_lead_id IN ${ids}
            ORDER BY t.dealer_lead_id, t.performed_at DESC
            LIMIT ${fetchCap}
        `),
        db.execute<StatusRow>(sql`
            SELECT
                h.dealer_lead_id AS lead_id,
                h.from_status,
                h.to_status,
                u.name AS changed_by_name,
                h.changed_at::text AS changed_at,
                h.to_lost_reason,
                h.reason_notes
            FROM dealer_lead_status_history h
            LEFT JOIN users u ON u.id::text = h.changed_by
            WHERE h.dealer_lead_id IN ${ids}
            ORDER BY h.dealer_lead_id, h.changed_at DESC
            LIMIT ${fetchCap}
        `),
    ]);

    const leadRows = leadRes as unknown as LeadRow[];
    const allTpRows = tpRes as unknown as TouchpointRow[];
    const allShRows = shRes as unknown as StatusRow[];

    const tpTruncated = allTpRows.length > ROW_CAP;
    const shTruncated = allShRows.length > ROW_CAP;
    const tpRows = tpTruncated ? allTpRows.slice(0, ROW_CAP) : allTpRows;
    const shRows = shTruncated ? allShRows.slice(0, ROW_CAP) : allShRows;

    if (tpTruncated || shTruncated) {
        console.warn(
            `[touchpointWorkbook] row cap hit for ${ids.length} leads — ` +
                `touchpoints truncated: ${tpTruncated}, status history truncated: ${shTruncated}`,
        );
    }

    // Events by lead, joined on the lead ID — not on Dealer + Phone, which is
    // not unique and used to be the only link between the sheets.
    const eventsByLead = new Map<string, HistoryEvent[]>();
    const push = (leadId: string, ev: HistoryEvent) => {
        const list = eventsByLead.get(leadId) ?? [];
        list.push(ev);
        eventsByLead.set(leadId, list);
    };
    for (const r of tpRows) push(r.lead_id, touchpointEvent(r));
    for (const r of shRows) push(r.lead_id, statusEvent(r));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(HISTORY_SHEET_NAME, {
        // Header stays put, and so do Dealer / Shop / Phone while the reader
        // scrolls right through the event block.
        views: [{ state: "frozen", ySplit: 1, xSplit: 3 }],
    });
    sheet.columns = [
        { header: "Dealer", key: "dealer", width: 26 },
        { header: "Shop", key: "shop", width: 24 },
        { header: "Phone", key: "phone", width: 16 },
        { header: "City", key: "city", width: 16 },
        { header: "State", key: "state", width: 16 },
        { header: "Lead Status", key: "status", width: 20 },
        { header: "Interest", key: "interest", width: 12 },
        { header: "Score", key: "score", width: 8 },
        { header: "Source", key: "source", width: 18 },
        { header: "Owner", key: "owner", width: 20 },
        { header: "ASM", key: "asm", width: 20 },
        { header: "Touchpoints", key: "count", width: 13 },
        { header: "Created (IST)", key: "created", width: 24 },
        // ── event block ──
        { header: "Event", key: "event", width: 14 },
        // "Activity" + "Details" are the two lines of the timeline card, in the
        // order they are read there: what happened, then what was written
        // about it. For a status change Activity is "From → To".
        { header: "Activity", key: "activity", width: 30 },
        { header: "By", key: "by", width: 22 },
        { header: "At (IST)", key: "at", width: 24 },
        { header: "Details", key: "details", width: 60 },
        { header: "Call Status", key: "call_status", width: 18 },
        { header: "Duration (sec)", key: "duration", width: 14 },
        { header: "Engaged", key: "engaged", width: 10 },
        { header: "Next Action", key: "next_action", width: 20 },
        { header: "Next Action At (IST)", key: "next_action_at", width: 24 },
        { header: "Lost Reason", key: "lost_reason", width: 22 },
        // Trails at the end for machine use.
        { header: "Type (code)", key: "type", width: 26 },
    ];
    styleHeader(sheet.getRow(1));

    let i = 0;
    for (const lead of leadRows) {
        const leadCells = {
            dealer: lead.dealer_name ?? DASH,
            shop: lead.shop_name ?? DASH,
            phone: lead.phone ?? DASH,
            city: lead.city ?? DASH,
            state: lead.state ?? DASH,
            status: statusText(lead.lead_status),
            interest: lead.interest_level
                ? lead.interest_level.charAt(0).toUpperCase() +
                  lead.interest_level.slice(1).replace(/_/g, " ")
                : DASH,
            score: lead.final_intent_score ?? DASH,
            source: lead.source ?? DASH,
            owner: lead.owner_name ?? DASH,
            asm: lead.asm_name ?? DASH,
            // COUNT(*) comes back as a bigint string on some drivers.
            count: Number(lead.touchpoint_count ?? 0),
            created: fmtIst(lead.created_at),
        };

        // Newest first within the lead, whichever table the event came from.
        // The timestamps are Postgres text in one timezone, so a string compare
        // orders them correctly; a null `at` sinks to the bottom.
        const events = (eventsByLead.get(lead.id) ?? []).sort((a, b) => {
            if (a.at === b.at) return 0;
            if (a.at == null) return 1;
            if (b.at == null) return -1;
            return a.at < b.at ? 1 : -1;
        });

        if (events.length === 0) {
            zebra(sheet.addRow({ ...leadCells, ...EMPTY_EVENT_CELLS }), i++);
            continue;
        }
        for (const ev of events) {
            zebra(sheet.addRow({ ...leadCells, ...ev.cells }), i++);
        }
    }

    if (i > 0) {
        sheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: sheet.columns.length },
        };
    }
    if (tpTruncated) markTruncated(sheet, ROW_CAP, "touchpoints");
    if (shTruncated) markTruncated(sheet, ROW_CAP, "status changes");

    return workbook;
}
