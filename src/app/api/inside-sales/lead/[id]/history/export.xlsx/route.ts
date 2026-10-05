/**
 * GET /api/inside-sales/lead/[id]/history/export.xlsx
 *
 * One .xlsx with two sheets for a single dealer lead:
 *   "Touchpoints"    — every row in lead_touchpoints (the full activity log).
 *   "Status History" — every status change in dealer_lead_status_history.
 *
 * Mirrors the ExcelJS styling used by the scraper run export. Timestamps are
 * rendered in IST. Used by the SI rep to hand off / archive a lead's history.
 *
 * Who may download (ID 58): canExportLeadHistory — the role list below, and a
 * rep / ASM / partner only for a lead they currently own. Every download is
 * written to data_download_log.
 *
 * The styling helpers now live in @/lib/excel/sheetStyle, shared with the
 * multi-lead version of this export (src/lib/leads/touchpointWorkbook.ts) so the
 * two files look identical whichever way a lead was exported.
 */

import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { engagedState } from "@/lib/reports/metricDefinitions";
import { withErrorHandler, errorResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { fmtIst as fmt, styleHeader, zebra } from "@/lib/excel/sheetStyle";
import { exportsOwnLeadsOnly, logDataDownload } from "@/lib/exports/downloadLog";
import { LEAD_HISTORY_EXPORT_ROLES, canExportLeadHistory } from "@/lib/leads/access";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import {
    CALL_STATUS_LABEL,
    NEXT_ACTION_LABEL,
    TOUCHPOINT_TYPE_LABEL,
    humanise,
} from "@/lib/lifecycle/touchpointLabels";

// The list lives in lib/leads/access.ts because the CRM lead-detail timeline
// decides whether to render the button from it — one list, so a visible button
// always corresponds to an endpoint that answers.
const READ_ROLES = [...LEAD_HISTORY_EXPORT_ROLES];

type LeadRow = {
    dealer_name: string | null;
    phone: string | null;
    current_owner_id: string | null;
};

type TouchpointRow = {
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
    from_status: string | null;
    to_status: string | null;
    changed_by_name: string | null;
    changed_at: string | null;
    to_lost_reason: string | null;
    reason_notes: string | null;
};

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        // ID 58: the role alone is not enough. A rep / ASM / partner may take
        // away the history of a lead they OWN, never a colleague's or an
        // unowned one — checked before any history is read.
        const leadRows = (await db.execute<LeadRow>(sql`
            SELECT dealer_name, phone, current_owner_id FROM dealer_leads WHERE id = ${id} LIMIT 1
        `)) as unknown as LeadRow[];
        const lead = leadRows[0];
        if (!lead) return errorResponse("Lead not found", 404);
        if (!canExportLeadHistory({ role: user.role, userId: user.id, currentOwnerId: lead.current_owner_id })) {
            return errorResponse("You can export the history of your own leads only.", 403);
        }

        const [touchpoints, statusHistory] = await Promise.all([
            db.execute<TouchpointRow>(sql`
                SELECT
                    t.touchpoint_type,
                    u.name AS performed_by_name,
                    t.performed_at::text AS performed_at,
                    t.call_status,
                    t.call_duration_sec,
                    -- ID 59: the definition, not the stored flag (as the workbook).
                    ${engagedState()} AS is_engaged,
                    t.remarks,
                    t.next_action,
                    t.next_action_at::text AS next_action_at
                FROM lead_touchpoints t
                LEFT JOIN users u ON u.id::text = t.performed_by
                WHERE t.dealer_lead_id = ${id}
                ORDER BY t.performed_at DESC
            `),
            db.execute<StatusRow>(sql`
                SELECT
                    h.from_status,
                    h.to_status,
                    u.name AS changed_by_name,
                    h.changed_at::text AS changed_at,
                    h.to_lost_reason,
                    h.reason_notes
                FROM dealer_lead_status_history h
                LEFT JOIN users u ON u.id::text = h.changed_by
                WHERE h.dealer_lead_id = ${id}
                ORDER BY h.changed_at DESC
            `),
        ]);

        const tpRows = touchpoints as unknown as TouchpointRow[];
        const shRows = statusHistory as unknown as StatusRow[];

        // Logged like every other lead export (E-312).
        const ownOnly = exportsOwnLeadsOnly(user.role);
        await logDataDownload({
            userId: user.id,
            role: user.role,
            dataset: `lead_history:${id}`,
            rowCount: tpRows.length + shRows.length,
            ownOnly,
            filters: { lead_id: id },
        });

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "iTarang";
        workbook.created = new Date();

        // ── Touchpoints ───────────────────────────────────────
        const tpSheet = workbook.addWorksheet("Touchpoints", {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        tpSheet.columns = [
            // Same wording, same column order as the bulk export
            // (src/lib/leads/touchpointWorkbook.ts): "Activity" then "Details"
            // are the two lines of the Activity-timeline card on screen.
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
                activity: humanise(r.touchpoint_type, TOUCHPOINT_TYPE_LABEL),
                by: r.performed_by_name ?? "System",
                at: fmt(r.performed_at),
                remarks: r.remarks ?? "—",
                call_status: humanise(r.call_status, CALL_STATUS_LABEL),
                duration: r.call_duration_sec ?? "—",
                engaged: r.is_engaged == null ? "—" : r.is_engaged ? "Yes" : "No",
                next_action: humanise(r.next_action, NEXT_ACTION_LABEL),
                next_action_at: r.next_action_at ? fmt(r.next_action_at) : "—",
                type: r.touchpoint_type ?? "—",
            });
            zebra(row, i);
        });
        if (tpRows.length > 0) {
            tpSheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: tpSheet.columns.length },
            };
        }

        // ── Status History ────────────────────────────────────
        const shSheet = workbook.addWorksheet("Status History", {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        shSheet.columns = [
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
                from: humanise(r.from_status, LEAD_STATUS_LABEL),
                to: humanise(r.to_status, LEAD_STATUS_LABEL),
                by: r.changed_by_name ?? "System",
                at: fmt(r.changed_at),
                lost_reason: r.to_lost_reason
                    ? r.to_lost_reason.replace(/_/g, " ")
                    : "—",
                notes: r.reason_notes ?? "—",
            });
            zebra(row, i);
        });
        if (shRows.length > 0) {
            shSheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: shSheet.columns.length },
            };
        }

        const buffer = await workbook.xlsx.writeBuffer();
        const safe = (lead.dealer_name || lead.phone || id).replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `lead_history_${safe}.xlsx`;

        return new Response(Buffer.from(buffer), {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": buffer.byteLength.toString(),
                "Cache-Control": "no-store",
            },
        });
    },
);
