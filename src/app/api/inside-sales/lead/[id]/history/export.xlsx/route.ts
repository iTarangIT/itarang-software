/**
 * GET /api/inside-sales/lead/[id]/history/export.xlsx
 *
 * One .xlsx with two sheets for a single dealer lead:
 *   "Touchpoints"    — every row in lead_touchpoints (the full activity log).
 *   "Status History" — every status change in dealer_lead_status_history.
 *
 * Mirrors the ExcelJS styling used by the scraper run export. Timestamps are
 * rendered in IST. Used by the SI rep to hand off / archive a lead's history.
 */

import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { withErrorHandler, errorResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";

import { dealerLeads, users, leadTouchpoints, dealerLeadStatusHistory } from "@/lib/db/schema";

const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

function styleHeader(row: ExcelJS.Row) {
    row.eachCell((cell) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1A1A1A" },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    row.height = 28;
}

function fmt(d: Date | string | null | undefined): string {
    return d
        ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "—";
}

function zebra(row: ExcelJS.Row, i: number) {
    if (i % 2 === 0) {
        row.eachCell((cell) => {
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF9FAFB" },
            };
        });
    }
    row.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    });
}

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
        await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const [leadRows, touchpoints, statusHistory] = await Promise.all([
            db.execute<{ dealer_name: string | null; phone: string | null }>(sql`
                SELECT dealer_name, phone FROM ${dealerLeads} WHERE id = ${id} LIMIT 1
            `),
            db.execute<TouchpointRow>(sql`
                SELECT
                    t.touchpoint_type,
                    u.name AS performed_by_name,
                    t.performed_at::text AS performed_at,
                    t.call_status,
                    t.call_duration_sec,
                    t.is_engaged,
                    t.remarks,
                    t.next_action,
                    t.next_action_at::text AS next_action_at
                FROM ${leadTouchpoints} t
                LEFT JOIN ${users} u ON u.id::text = t.performed_by
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
                FROM ${dealerLeadStatusHistory} h
                LEFT JOIN ${users} u ON u.id::text = h.changed_by
                WHERE h.dealer_lead_id = ${id}
                ORDER BY h.changed_at DESC
            `),
        ]);

        const lead = (leadRows as unknown as { dealer_name: string | null; phone: string | null }[])[0];
        if (!lead) return errorResponse("Lead not found", 404);

        const tpRows = touchpoints as unknown as TouchpointRow[];
        const shRows = statusHistory as unknown as StatusRow[];

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "iTarang";
        workbook.created = new Date();

        // ── Touchpoints ───────────────────────────────────────
        const tpSheet = workbook.addWorksheet("Touchpoints", {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        tpSheet.columns = [
            { header: "Type", key: "type", width: 24 },
            { header: "Performed By", key: "by", width: 22 },
            { header: "Performed At (IST)", key: "at", width: 24 },
            { header: "Call Status", key: "call_status", width: 16 },
            { header: "Duration (sec)", key: "duration", width: 14 },
            { header: "Engaged", key: "engaged", width: 10 },
            { header: "Remarks", key: "remarks", width: 50 },
            { header: "Next Action", key: "next_action", width: 20 },
            { header: "Next Action At (IST)", key: "next_action_at", width: 24 },
        ];
        styleHeader(tpSheet.getRow(1));
        tpRows.forEach((r, i) => {
            const row = tpSheet.addRow({
                type: r.touchpoint_type ?? "—",
                by: r.performed_by_name ?? "System",
                at: fmt(r.performed_at),
                call_status: r.call_status ?? "—",
                duration: r.call_duration_sec ?? "—",
                engaged: r.is_engaged == null ? "—" : r.is_engaged ? "Yes" : "No",
                remarks: r.remarks ?? "—",
                next_action: r.next_action ?? "—",
                next_action_at: r.next_action_at ? fmt(r.next_action_at) : "—",
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
                from: r.from_status ?? "—",
                to: r.to_status ?? "—",
                by: r.changed_by_name ?? "System",
                at: fmt(r.changed_at),
                lost_reason: r.to_lost_reason ?? "—",
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
