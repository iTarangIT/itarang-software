// GET /api/admin/exports/lead-events.xlsx?from=YYYY-MM-DD&to=YYYY-MM-DD
//        [&lead_ids=a,b,c][&performer=<user id>]
//
// Review R-21 (sheet 9, Requirements #34 and #44) — every event on the chosen
// leads, filtered by WHEN IT HAPPENED, one row per event, plus a Summary sheet
// of counts per person (sheet 9 §C layout). See src/lib/leads/eventLog.ts for
// the event sources; interest history and field edits need E-304, and the
// Summary sheet says so when a host lacks it.
//
// Every download writes an audit_logs row (who, when, filter, row count) before
// the file is built, like the KYC export. Above EVENT_LOG_ROW_CAP events the
// route refuses with a 400 asking for a narrower range rather than truncating.

import ExcelJS from "exceljs";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { styleHeader, zebra } from "@/lib/excel/sheetStyle";
import { businessTypeLabel } from "@/lib/leads/businessType";
import {
    EVENT_LOG_ROW_CAP,
    countEvents,
    eventSources,
    fetchEvents,
    summarizeEvents,
    type EventLogFilters,
} from "@/lib/leads/eventLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const READ_ROLES = ["admin", "ceo", "business_head", "sales_head", "partner"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-21 14:05:00.123" (already IST wall-clock) → a Date Excel shows as that time. */
function excelIst(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(`${v.replace(" ", "T").slice(0, 19)}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from") ?? "";
    const to = sp.get("to") ?? "";
    if (!ISO.test(from) || !ISO.test(to)) return errorResponse("from and to must be YYYY-MM-DD.", 400);
    if (from > to) return errorResponse("`from` must not be after `to`.", 400);
    const leadIds = (sp.get("lead_ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5000);
    const performer = sp.get("performer")?.trim() || undefined;
    const f: EventLogFilters = { from, to, leadIds: leadIds.length ? leadIds : undefined, performerId: performer };

    const n = await countEvents(f);
    if (n > EVENT_LOG_ROW_CAP) {
        return errorResponse(
            `${n.toLocaleString("en-IN")} events match — more than the ${EVENT_LOG_ROW_CAP.toLocaleString("en-IN")} a download can hold. Narrow the date range or select fewer leads.`,
            400,
        );
    }

    await db.insert(auditLogs).values({
        id: `AUDIT-EVTX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        entity_type: "lead_events_export",
        entity_id: leadIds.length === 1 ? leadIds[0]! : "bulk",
        action: "exported",
        performed_by: user.id,
        changes: { filters: { from, to, performer: performer ?? null }, selected_ids: leadIds.length, row_count: n },
    });

    const [rows, summary, src] = await Promise.all([fetchEvents(f), summarizeEvents(f), eventSources()]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Events");
    const COLS: Array<{ header: string; width: number; value: (r: (typeof rows)[number]) => ExcelJS.CellValue; numFmt?: string }> = [
        { header: "Event time (IST)", width: 19, value: (r) => excelIst(r.event_at), numFmt: "dd-mmm-yyyy hh:mm" },
        { header: "Lead ID", width: 24, value: (r) => r.lead_id },
        { header: "Dealer / shop", width: 28, value: (r) => r.dealer },
        { header: "City", width: 14, value: (r) => r.city },
        { header: "State", width: 14, value: (r) => r.state },
        { header: "Business type", width: 14, value: (r) => businessTypeLabel(r.business_type) },
        { header: "Event type", width: 22, value: (r) => r.event_type },
        { header: "From", width: 22, value: (r) => r.from_value },
        { header: "To", width: 26, value: (r) => r.to_value },
        { header: "Performed by", width: 20, value: (r) => r.performed_by },
        { header: "Role", width: 16, value: (r) => (r.role ?? "").replace(/_/g, " ") || null },
        { header: "Channel", width: 14, value: (r) => r.channel },
        { header: "Outcome / disposition", width: 24, value: (r) => r.outcome },
        { header: "Duration (s)", width: 11, value: (r) => r.duration_sec },
        { header: "Remarks", width: 50, value: (r) => r.remarks },
    ];
    ws.columns = COLS.map((c) => ({ header: c.header, width: c.width }));
    styleHeader(ws.getRow(1));
    rows.forEach((r, i) => {
        const row = ws.addRow(COLS.map((c) => c.value(r)));
        COLS.forEach((c, j) => {
            if (c.numFmt) row.getCell(j + 1).numFmt = c.numFmt;
        });
        zebra(row, i);
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    // Sheet 9 §C, in its column order, then the extra counts the log also has.
    const sum = wb.addWorksheet("Summary");
    sum.columns = [
        { header: "Period", width: 24 },
        { header: "SPOC", width: 24 },
        { header: "Status changes", width: 15 },
        { header: "Log detail changes", width: 18 },
        { header: "Visits logged", width: 14 },
        { header: "New visits", width: 12 },
        { header: "Quotations requested", width: 20 },
        { header: "Quotations approved", width: 20 },
        { header: "Quotations rejected", width: 20 },
        { header: "Owner changes", width: 15 },
        { header: "Interest changes", width: 16 },
        { header: "Calls", width: 10 },
    ];
    styleHeader(sum.getRow(1));
    const period = from === to ? from : `${from} to ${to}`;
    summary.forEach((x, i) =>
        zebra(
            sum.addRow([
                period, x.person, x.status_changes, x.log_detail_changes, x.visits_logged,
                x.new_visits, x.quotes_requested, x.quotes_approved, x.quotes_rejected,
                x.owner_changes, x.interest_changes, x.calls,
            ]),
            i,
        ),
    );
    sum.addRow([]);
    sum.addRow([
        `Filter: events from ${from} to ${to}${leadIds.length ? `, ${leadIds.length} selected lead(s)` : ", all leads"}. ` +
            "Quotations approved / rejected are counted for the SPOC who requested them.",
    ]);
    if (!src.interestHistory || !src.fieldChanges) {
        sum.addRow([
            "This database does not yet record " +
                [!src.interestHistory && "every interest change (only manual overrides are shown)", !src.fieldChanges && "field edits (log detail changes)"]
                    .filter(Boolean)
                    .join(" or ") +
                " — apply migration E-304.",
        ]);
    } else {
        sum.addRow(["Interest changes and field edits are recorded from the day migration E-304 was applied; earlier edits were never stored."]);
    }

    const buffer = await wb.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="lead-events-${from}-to-${to}.xlsx"`,
            "Cache-Control": "private, no-store",
        },
    });
});
