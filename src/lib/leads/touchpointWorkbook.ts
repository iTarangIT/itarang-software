/**
 * Multi-lead touchpoint-history workbook.
 *
 * The single-lead equivalent lives at
 * src/app/api/inside-sales/lead/[id]/history/export.xlsx/route.ts and produces
 * two sheets for ONE lead. This builds the batch version behind the /leads bulk
 * bar: pick N leads, get one file. Same tables, same joins, same IST rendering —
 * a lead exported both ways must produce identical rows.
 *
 * Three sheets, in the order someone actually reads them:
 *   "Leads"          — one row per selected lead (the headline).
 *   "Touchpoints"    — every touchpoint of every selected lead, flattened.
 *   "Status History" — every status change of every selected lead, flattened.
 *
 * The flat sheets carry the lead's identity in their leading columns; without
 * that, flattening many leads into one sheet makes a row unattributable.
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
 * nothing caps the TOUCHPOINT count, and 5,000 chatty leads is six figures of
 * rows. Stop at this many per sheet and say so in the sheet itself — a silently
 * short export reads exactly like a complete one.
 */
const ROW_CAP = 100_000;

const DASH = "—";

/**
 * The sheet must read like the Activity timeline on screen, not like the table
 * underneath it. A row saying `quote_dispatched` / `Assigned_Not_Contacted` is
 * a database dump; the person opening this file saw "Quote sent to dealer" and
 * "Assigned", and those are the words that have to arrive in Excel.
 *
 * The raw codes are kept in their own trailing columns rather than dropped —
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
    last_touchpoint_at: string | null;
    created_at: string | null;
    touchpoint_count: number | string | null;
};

type TouchpointRow = {
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
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
    dealer_name: string | null;
    phone: string | null;
    from_status: string | null;
    to_status: string | null;
    changed_by_name: string | null;
    changed_at: string | null;
    to_lost_reason: string | null;
    reason_notes: string | null;
};

/** Appends a single, visible "this file is incomplete" row. */
function markTruncated(sheet: ExcelJS.Worksheet, cap: number) {
    const row = sheet.addRow([
        `— truncated at ${cap.toLocaleString("en-IN")} rows —`,
    ]);
    row.font = { bold: true, color: { argb: "FFB45309" } };
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
                dl.last_touchpoint_at::text AS last_touchpoint_at,
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
                dl.dealer_name,
                dl.shop_name,
                dl.phone,
                dl.city,
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
            JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
            LEFT JOIN users u ON u.id::text = t.performed_by
            WHERE t.dealer_lead_id IN ${ids}
            -- dl.id is the tiebreaker, not decoration: plenty of leads have a
            -- NULL dealer_name, and without it two unnamed leads interleave
            -- row-by-row and the sheet stops reading as "one lead at a time".
            ORDER BY dl.dealer_name NULLS LAST, dl.id, t.performed_at DESC
            LIMIT ${fetchCap}
        `),
        db.execute<StatusRow>(sql`
            SELECT
                dl.dealer_name,
                dl.phone,
                h.from_status,
                h.to_status,
                u.name AS changed_by_name,
                h.changed_at::text AS changed_at,
                h.to_lost_reason,
                h.reason_notes
            FROM dealer_lead_status_history h
            JOIN dealer_leads dl ON dl.id = h.dealer_lead_id
            LEFT JOIN users u ON u.id::text = h.changed_by
            WHERE h.dealer_lead_id IN ${ids}
            ORDER BY dl.dealer_name NULLS LAST, dl.id, h.changed_at DESC
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

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";
    workbook.created = new Date();

    // ── Leads ─────────────────────────────────────────────
    const leadSheet = workbook.addWorksheet("Leads", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    leadSheet.columns = [
        { header: "Dealer", key: "dealer", width: 26 },
        { header: "Shop", key: "shop", width: 24 },
        { header: "Phone", key: "phone", width: 16 },
        { header: "City", key: "city", width: 16 },
        { header: "State", key: "state", width: 16 },
        { header: "Status", key: "status", width: 20 },
        { header: "Interest", key: "interest", width: 12 },
        { header: "Score", key: "score", width: 8 },
        { header: "Source", key: "source", width: 18 },
        { header: "Owner", key: "owner", width: 20 },
        { header: "ASM", key: "asm", width: 20 },
        { header: "Touchpoints", key: "count", width: 13 },
        { header: "Last Touch (IST)", key: "last_touch", width: 24 },
        { header: "Created (IST)", key: "created", width: 24 },
    ];
    styleHeader(leadSheet.getRow(1));
    leadRows.forEach((r, i) => {
        const row = leadSheet.addRow({
            dealer: r.dealer_name ?? DASH,
            shop: r.shop_name ?? DASH,
            phone: r.phone ?? DASH,
            city: r.city ?? DASH,
            state: r.state ?? DASH,
            status: statusText(r.lead_status),
            interest: r.interest_level
                ? r.interest_level.charAt(0).toUpperCase() +
                  r.interest_level.slice(1).replace(/_/g, " ")
                : DASH,
            score: r.final_intent_score ?? DASH,
            source: r.source ?? DASH,
            owner: r.owner_name ?? DASH,
            asm: r.asm_name ?? DASH,
            // COUNT(*) comes back as a bigint string on some drivers.
            count: Number(r.touchpoint_count ?? 0),
            last_touch: fmtIst(r.last_touchpoint_at),
            created: fmtIst(r.created_at),
        });
        zebra(row, i);
    });
    if (leadRows.length > 0) {
        leadSheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: leadSheet.columns.length },
        };
    }

    // ── Touchpoints ───────────────────────────────────────
    const tpSheet = workbook.addWorksheet("Touchpoints", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    tpSheet.columns = [
        { header: "Dealer", key: "dealer", width: 26 },
        { header: "Shop", key: "shop", width: 24 },
        { header: "Phone", key: "phone", width: 16 },
        { header: "City", key: "city", width: 16 },
        // "Activity" + "Details" are the two lines of the timeline card, in the
        // order they are read there: what happened, then what was written about
        // it. "Type (code)" trails at the end for machine use.
        { header: "Activity", key: "activity", width: 26 },
        { header: "Performed By", key: "by", width: 22 },
        { header: "Performed At (IST)", key: "at", width: 24 },
        { header: "Details", key: "remarks", width: 60 },
        { header: "Call Status", key: "call_status", width: 18 },
        { header: "Duration (sec)", key: "duration", width: 14 },
        { header: "Engaged", key: "engaged", width: 10 },
        { header: "Next Action", key: "next_action", width: 20 },
        { header: "Next Action At (IST)", key: "next_action_at", width: 24 },
        { header: "Type (code)", key: "type", width: 24 },
    ];
    styleHeader(tpSheet.getRow(1));
    tpRows.forEach((r, i) => {
        const row = tpSheet.addRow({
            dealer: r.dealer_name ?? DASH,
            shop: r.shop_name ?? DASH,
            phone: r.phone ?? DASH,
            city: r.city ?? DASH,
            activity: humanise(r.touchpoint_type, TOUCHPOINT_TYPE_LABEL),
            by: r.performed_by_name ?? "System",
            at: fmtIst(r.performed_at),
            remarks: r.remarks ?? DASH,
            call_status: humanise(r.call_status, CALL_STATUS_LABEL),
            duration: r.call_duration_sec ?? DASH,
            engaged: r.is_engaged == null ? DASH : r.is_engaged ? "Yes" : "No",
            next_action: humanise(r.next_action, NEXT_ACTION_LABEL),
            next_action_at: r.next_action_at ? fmtIst(r.next_action_at) : DASH,
            type: r.touchpoint_type ?? DASH,
        });
        zebra(row, i);
    });
    if (tpRows.length > 0) {
        tpSheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: tpSheet.columns.length },
        };
    }
    if (tpTruncated) markTruncated(tpSheet, ROW_CAP);

    // ── Status History ────────────────────────────────────
    const shSheet = workbook.addWorksheet("Status History", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    shSheet.columns = [
        { header: "Dealer", key: "dealer", width: 26 },
        { header: "Phone", key: "phone", width: 16 },
        { header: "From", key: "from", width: 24 },
        { header: "To", key: "to", width: 24 },
        { header: "Changed By", key: "by", width: 22 },
        { header: "Changed At (IST)", key: "at", width: 24 },
        { header: "Lost Reason", key: "lost_reason", width: 22 },
        { header: "Notes", key: "notes", width: 50 },
    ];
    styleHeader(shSheet.getRow(1));
    shRows.forEach((r, i) => {
        const row = shSheet.addRow({
            dealer: r.dealer_name ?? DASH,
            phone: r.phone ?? DASH,
            from: statusText(r.from_status),
            to: statusText(r.to_status),
            by: r.changed_by_name ?? "System",
            at: fmtIst(r.changed_at),
            lost_reason: r.to_lost_reason
                ? r.to_lost_reason.replace(/_/g, " ")
                : DASH,
            notes: r.reason_notes ?? DASH,
        });
        zebra(row, i);
    });
    if (shRows.length > 0) {
        shSheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: shSheet.columns.length },
        };
    }
    if (shTruncated) markTruncated(shSheet, ROW_CAP);

    return workbook;
}
