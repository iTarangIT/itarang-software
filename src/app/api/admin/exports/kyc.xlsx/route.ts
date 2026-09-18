// GET  /api/admin/exports/kyc.xlsx?from=&to=&dealer_id=&city=&status=&lead_ids=a,b,c
// POST /api/admin/exports/kyc.xlsx  { lead_ids: [...], from?, to?, dealer_id?, status? }
//
// B12 — applicant KYC data for one, some or all cases, as an Excel workbook.
// POST exists for long id lists ("Export selected") that would not fit a URL.
//
// SENSITIVE. Admin, CEO and sales head only. No PAN / Aadhaar / bank numbers — the query
// (src/lib/admin/kycExport.ts) never selects them, and the phone is masked to
// its last four digits for everyone. Every export is written to audit_logs
// (who, when, filters, row count) BEFORE the file is returned, so a download
// that was never logged cannot happen.

import ExcelJS from "exceljs";
import { z } from "zod";

import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { maskPhone } from "@/lib/whatsapp/notifications";
import { styleHeader, zebra } from "@/lib/excel/sheetStyle";
import {
    KYC_EXPORT_MAX_IDS,
    fetchKycExportRows,
    type KycExportFilters,
    type KycExportRow,
} from "@/lib/admin/kycExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// sales_head added 2026-09-18 on request. Phone stays masked and the audit
// row is written for every role alike.
const READ_ROLES = ["admin", "ceo", "sales_head"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const FiltersSchema = z.object({
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
    dealer_id: z.string().trim().min(1).max(64).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    lead_ids: z.array(z.string().trim().min(1).max(64)).max(KYC_EXPORT_MAX_IDS).optional(),
});

function yn(v: boolean): string {
    return v ? "Y" : "N";
}

function excelDateTimeIst(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
}

async function exportKyc(userId: string, raw: unknown): Promise<Response> {
    const parsed = FiltersSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid filters.", 400);
    const f: KycExportFilters = parsed.data;
    if (f.from && f.to && f.from > f.to) return errorResponse("`from` must not be after `to`.", 400);

    const rows = await fetchKycExportRows(f);

    // Logged first. If the log insert fails the export fails — a KYC download
    // with no record of who took it is the outcome this exists to prevent.
    await db.insert(auditLogs).values({
        id: `AUDIT-KYCX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        entity_type: "kyc_export",
        entity_id: f.lead_ids?.length === 1 ? f.lead_ids[0]! : "bulk",
        action: "exported",
        performed_by: userId,
        changes: {
            filters: { from: f.from ?? null, to: f.to ?? null, dealer_id: f.dealer_id ?? null, city: f.city ?? null, status: f.status ?? null },
            selected_ids: f.lead_ids?.length ?? 0,
            row_count: rows.length,
            columns: "no document numbers; phone masked",
        },
    });

    type Col = { header: string; width: number; value: (r: KycExportRow) => ExcelJS.CellValue; numFmt?: string };
    const COLUMNS: Col[] = [
        { header: "Lead ID", width: 26, value: (r) => r.lead_id },
        { header: "Applicant name", width: 26, value: (r) => r.applicant_name ?? null },
        { header: "Phone", width: 12, value: (r) => (r.phone ? maskPhone(r.phone) : null) },
        { header: "Dealer", width: 26, value: (r) => r.dealer_name ?? null },
        { header: "City", width: 16, value: (r) => r.city ?? null },
        { header: "KYC status", width: 16, value: (r) => r.kyc_status ?? null },
        { header: "KYC score", width: 10, value: (r) => r.kyc_score },
        { header: "PAN verified", width: 12, value: (r) => yn(r.pan_verified) },
        { header: "Aadhaar verified", width: 14, value: (r) => yn(r.aadhaar_verified) },
        { header: "Bank verified", width: 12, value: (r) => yn(r.bank_verified) },
        { header: "CIBIL fetched", width: 12, value: (r) => yn(r.cibil_fetched) },
        { header: "Outcome", width: 24, value: (r) => r.outcome ?? null },
        { header: "Rejection reason", width: 40, value: (r) => r.rejection_reason ?? null },
        { header: "Additional doc requested", width: 30, value: (r) => r.additional_doc_requested ?? null },
        { header: "Reviewer", width: 20, value: (r) => r.reviewer_name ?? null },
        { header: "Reviewed at", width: 18, value: (r) => excelDateTimeIst(r.reviewed_at), numFmt: "dd-mmm-yyyy hh:mm" },
        { header: "Submitted at", width: 18, value: (r) => excelDateTimeIst(r.submitted_at), numFmt: "dd-mmm-yyyy hh:mm" },
    ];

    const wb = new ExcelJS.Workbook();
    wb.creator = "iTarang CRM";
    wb.created = new Date();
    const ws = wb.addWorksheet("KYC", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
    styleHeader(ws.getRow(1));
    COLUMNS.forEach((c, i) => {
        if (c.numFmt) ws.getColumn(i + 1).numFmt = c.numFmt;
    });
    rows.forEach((r, i) => zebra(ws.addRow(COLUMNS.map((c) => c.value(r) ?? null)), i));
    if (rows.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

    const buffer = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="kyc-${stamp}.xlsx"`,
            "Cache-Control": "no-store",
            "X-Export-Rows": String(rows.length),
        },
    });
}

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const p = new URL(req.url).searchParams;
    const idsRaw = p.get("lead_ids")?.trim();
    return exportKyc(user.id, {
        from: p.get("from")?.trim() || undefined,
        to: p.get("to")?.trim() || undefined,
        dealer_id: p.get("dealer_id")?.trim() || undefined,
        city: p.get("city")?.trim() || undefined,
        status: p.get("status")?.trim() || undefined,
        lead_ids: idsRaw ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return exportKyc(user.id, {
        from: typeof body.from === "string" && body.from ? body.from : undefined,
        to: typeof body.to === "string" && body.to ? body.to : undefined,
        dealer_id: typeof body.dealer_id === "string" && body.dealer_id ? body.dealer_id : undefined,
        city: typeof body.city === "string" && body.city ? body.city : undefined,
        status: typeof body.status === "string" && body.status ? body.status : undefined,
        lead_ids: Array.isArray(body.lead_ids) ? body.lead_ids : undefined,
    });
});
