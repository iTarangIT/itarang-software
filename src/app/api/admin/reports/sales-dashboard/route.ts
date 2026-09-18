// GET /api/admin/reports/sales-dashboard
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD&city=&state=&spoc_id=&business_type=&granularity=day|week|month
//
// B6 — the admin / sales-leadership view of visits, calls and hot/warm/cold
// with ageing. Without spoc_id the response carries a per-rep breakdown
// (section E); with it, sections A–D describe that one rep.
//
// Lives OUTSIDE the [type] catalogue route on purpose: that one returns the
// flat ReportResult { columns, rows } shape the reports hub tabulates, and this
// is a multi-section object. Sharing the URL prefix keeps it findable.

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    buildSalesDashboard,
    parseSalesDashboardParams,
    resolveSalesDashboardFilters,
    salesDashboardCsv,
} from "@/lib/admin/salesDashboard";
import { csvResponse } from "@/lib/leads/queueCsv";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "business_head", "partner"];

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);

    let params;
    try {
        params = parseSalesDashboardParams(new URL(req.url));
    } catch (e) {
        if (e instanceof z.ZodError) {
            return errorResponse(e.issues[0]?.message ?? "Invalid query.", 400);
        }
        throw e;
    }

    // The builder re-checks the window against Postgres' IST "today"; this
    // early pass only exists to turn an impossible range into a 400 instead of
    // a 500. `today` is a placeholder here — only the from > to / span checks
    // can fire when both ends are supplied.
    if (params.from && params.to) {
        try {
            resolveSalesDashboardFilters(params, params.to);
        } catch (e) {
            if (e instanceof RangeError) return errorResponse(e.message, 400);
            throw e;
        }
    }

    const dashboard = await buildSalesDashboard({
        from: params.from ?? null,
        to: params.to ?? null,
        city: params.city ?? null,
        state: params.state ?? null,
        spoc_id: params.spoc_id ?? null,
        business_type: params.business_type ?? null,
        granularity: params.granularity,
    });
    // B7 — ?format=csv: the rows of the screen's main table, as a sheet.
    if (new URL(req.url).searchParams.get("format") === "csv") {
        const sheet = salesDashboardCsv(dashboard);
        return csvResponse({
            rows: sheet.rows,
            columns: sheet.columns,
            filename: sheet.filename,
            total: sheet.rows.length,
        });
    }
    return successResponse(dashboard);
});
