// GET /api/admin/reports/team-performance
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD&state=&city=&business_type=&team=all|field|inside[&format=xlsx|csv]
//
// Sales Head › Team performance (26 Nov task): the whole team's visits,
// Hot/Warm/Cold, quotes, dealers onboarded, conversion and progress against
// target, each person's target status (posted / pushed / accepted), and the
// downloadable team activity report — .xlsx (Summary, People, Targets) or the
// People sheet as CSV. See src/lib/dashboard/teamPerformance.ts.

import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { buildTeamPerformance } from "@/lib/dashboard/teamPerformance";
import { peopleSheet, reportFilename, teamPerformanceSheets } from "@/lib/dashboard/teamPerformanceReport";
import { csvEscape, csvDateTime } from "@/lib/leads/queueCsv";
import { styleHeader, zebra } from "@/lib/excel/sheetStyle";
import { SALES_DASHBOARD_MAX_DAYS } from "@/lib/admin/salesDashboardTypes";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "business_head"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const Params = z.object({
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
    state: z.string().max(80).optional(),
    city: z.string().max(80).optional(),
    business_type: z.string().max(40).optional(),
    team: z.enum(["all", "field", "inside"]).default("all"),
    format: z.enum(["json", "xlsx", "csv"]).default("json"),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const sp = new URL(req.url).searchParams;
    const parsed = Params.safeParse(Object.fromEntries([...sp.entries()].filter(([, v]) => v !== "")));
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid query.", 400);
    const p = parsed.data;
    if (p.from && p.to) {
        if (p.from > p.to) return errorResponse("From must be on or before To.", 400);
        const span = (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 + 1;
        if (span > SALES_DASHBOARD_MAX_DAYS) return errorResponse(`Pick at most ${SALES_DASHBOARD_MAX_DAYS} days.`, 400);
    }

    let data;
    try {
        data = await buildTeamPerformance({
            from: p.from ?? null,
            to: p.to ?? null,
            state: p.state ?? null,
            city: p.city ?? null,
            business_type: p.business_type ?? null,
            team: p.team,
        });
    } catch (e) {
        if (e instanceof RangeError) return errorResponse(e.message, 400);
        throw e;
    }

    const stamp = csvDateTime(new Date()).replace(/[: ]/g, "-");
    const name = `${reportFilename(data)}-${stamp}`;

    if (p.format === "csv") {
        const s = peopleSheet(data);
        const lines = [s.headers.map(csvEscape).join(","), ...s.rows.map((r) => r.map(csvEscape).join(","))];
        return new Response("﻿" + lines.join("\r\n"), {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${name}.csv"`,
                "Cache-Control": "no-store",
            },
        });
    }

    if (p.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "iTarang CRM";
        wb.created = new Date();
        for (const s of teamPerformanceSheets(data)) {
            const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 1 }] });
            ws.columns = s.headers.map((h, i) => ({
                header: h,
                width: s.name === "Summary" ? (i === 0 ? 42 : 70) : Math.min(40, Math.max(12, h.length + 4)),
            }));
            styleHeader(ws.getRow(1));
            s.rows.forEach((r, i) => {
                const row = ws.addRow(r);
                zebra(row, i);
                // The People sheet's last row is the team total.
                if (s.name === "People" && i === s.rows.length - 1) row.font = { bold: true };
            });
        }
        const buffer = await wb.xlsx.writeBuffer();
        return new Response(new Uint8Array(buffer as ArrayBuffer), {
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${name}.xlsx"`,
                "Cache-Control": "no-store",
            },
        });
    }

    return successResponse(data);
});
