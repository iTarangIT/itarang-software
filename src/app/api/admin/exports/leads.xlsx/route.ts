// GET /api/admin/exports/leads.xlsx?<the /leads filters>
//
// B11 — every dealer lead matching the current list filters, one row each,
// with visit, call, remarks and billing columns (src/lib/admin/leadsExport.ts
// says what each means and how billing is matched). Same filter params as the
// list and the follow-up export, parsed by the same reader, so all three agree
// about which leads matched.
//
// Phone is MASKED unless the caller is admin, ceo or sales_head. Dates are written as real
// Excel dates (typed cells), not text, so the sheet sorts and filters on them.
// Above LEADS_EXPORT_ROW_CAP rows the route refuses with a 400 asking for a
// narrower filter rather than silently truncating.

import ExcelJS from "exceljs";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { capabilitiesFor } from "@/lib/leads/access";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { businessTypeLabel } from "@/lib/leads/businessType";
import { maskPhone } from "@/lib/whatsapp/notifications";
import { styleHeader, zebra } from "@/lib/excel/sheetStyle";
import {
    LEADS_EXPORT_ROW_CAP,
    countLeadsForExport,
    fetchLeadsForExport,
    type LeadsExportRow,
} from "@/lib/admin/leadsExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const READ_ROLES = ["admin", "ceo", "business_head", "sales_head", "partner"];
// sales_head added 2026-09-18 on request — they run the follow-up calls, so a
// masked number would send them back to the screen for every row.
const FULL_PHONE_ROLES = new Set(["admin", "ceo", "sales_head"]);

/** A date-only string → a Date at UTC midnight, which Excel shows as that calendar day. */
function excelDate(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A timestamp → the same instant shifted so Excel displays IST wall-clock. */
function excelDateTimeIst(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
}

type Col = {
    header: string;
    width: number;
    value: (r: LeadsExportRow) => ExcelJS.CellValue;
    numFmt?: string;
};

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const caps = capabilitiesFor(user.role);
    const fullPhone = FULL_PHONE_ROLES.has((user.role ?? "").toLowerCase());

    const searchParams = new URL(req.url).searchParams;
    const filters = await parseLeadListFilters(searchParams, caps);

    const total = await countLeadsForExport(filters);
    if (total > LEADS_EXPORT_ROW_CAP) {
        return errorResponse(
            `${total.toLocaleString("en-IN")} leads match; the export is capped at ${LEADS_EXPORT_ROW_CAP.toLocaleString("en-IN")}. Narrow the filters (date range, state, status) and try again.`,
            400,
        );
    }

    const rows = await fetchLeadsForExport(filters);

    const COLUMNS: Col[] = [
        { header: "Lead ID", width: 24, value: (r) => r.lead_id },
        { header: "Dealer name", width: 28, value: (r) => r.dealer_name ?? r.shop_name ?? null },
        { header: "Shop", width: 24, value: (r) => r.shop_name ?? null },
        { header: "Phone", width: 16, value: (r) => (fullPhone ? r.phone : r.phone ? maskPhone(r.phone) : null) },
        { header: "City", width: 16, value: (r) => r.city ?? null },
        { header: "State", width: 16, value: (r) => r.state ?? null },
        // R-19 — "Not set" rather than a blank: every lead before 17-Sep has no
        // type, and a blank cell reads as missing data, not as a bucket.
        { header: "Type of business", width: 16, value: (r) => businessTypeLabel(r.business_type) },
        { header: "Status", width: 22, value: (r) => r.lead_status ?? null },
        { header: "Interest", width: 10, value: (r) => r.interest_level ?? null },
        { header: "Sales POC", width: 22, value: (r) => r.owner_name ?? null },
        { header: "Last visit date", width: 14, value: (r) => excelDate(r.last_visit_date), numFmt: "dd-mmm-yyyy" },
        { header: "Next visit date", width: 14, value: (r) => excelDate(r.next_visit_date), numFmt: "dd-mmm-yyyy" },
        { header: "Last calling date", width: 18, value: (r) => excelDateTimeIst(r.last_call_at), numFmt: "dd-mmm-yyyy hh:mm" },
        { header: "Next calling date", width: 18, value: (r) => excelDateTimeIst(r.next_call_at), numFmt: "dd-mmm-yyyy hh:mm" },
        { header: "Latest remarks", width: 60, value: (r) => r.latest_remarks ?? null },
        { header: "Business till date (₹)", width: 18, value: (r) => (r.business_till_date == null ? null : Number(r.business_till_date)), numFmt: "#,##0.00" },
        { header: "Last billing date", width: 14, value: (r) => excelDate(r.last_billing_date), numFmt: "dd-mmm-yyyy" },
        { header: "Visits before first billing", width: 14, value: (r) => r.visits_before_first_billing ?? null },
        { header: "Billing match", width: 12, value: (r) => r.billing_match },
    ];

    const wb = new ExcelJS.Workbook();
    wb.creator = "iTarang CRM";
    wb.created = new Date();
    const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
    styleHeader(ws.getRow(1));
    COLUMNS.forEach((c, i) => {
        if (c.numFmt) ws.getColumn(i + 1).numFmt = c.numFmt;
    });
    rows.forEach((r, i) => {
        const row = ws.addRow(COLUMNS.map((c) => c.value(r) ?? null));
        zebra(row, i);
    });
    if (rows.length > 0) {
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
    }

    // A second sheet stating what the columns mean, so the file explains itself
    // to whoever opens it without the CRM in front of them.
    const notes = wb.addWorksheet("Notes");
    notes.columns = [{ header: "Column", width: 28 }, { header: "Meaning", width: 110 }];
    styleHeader(notes.getRow(1));
    [
        ["Sales POC", "The lead's current owner in the CRM."],
        ["Last / next visit", "From logged field visits: latest actual visit; earliest open scheduled visit on or after today (IST)."],
        ["Last / next calling date", "From inside-sales and AI-dialer call touchpoints: latest call; earliest planned next action on or after now (IST)."],
        ["Latest remarks", "Remarks on the most recent touchpoint of any type."],
        ["Business till date", "Assumption A12: invoiced value — the sum of invoice totals across sales and Zoho invoices, deduplicated by invoice number."],
        ["Billing match", "'name' = invoices were matched to this lead by customer name (best effort, no dealer id exists on invoices yet); 'none' = no invoice matched, so billing cells are blank, not zero."],
        ["Visits before first billing", "Logged visits dated before the first matched invoice. Blank when no invoice matched."],
        ["Phone", fullPhone ? "Full number (admin / CEO / sales head)." : "Masked to the last four digits for this role."],
    ].forEach((r, i) => zebra(notes.addRow(r), i));

    const buffer = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="all-leads-${stamp}.xlsx"`,
            "Cache-Control": "no-store",
            "X-Export-Rows": String(rows.length),
            "X-Export-Total": String(total),
            "X-Export-Truncated": "0",
        },
    });
});
