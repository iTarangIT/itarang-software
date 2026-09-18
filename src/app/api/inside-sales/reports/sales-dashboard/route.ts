// GET /api/inside-sales/reports/sales-dashboard
//   ?from=&to=&city=&state=&business_type=&granularity=day|week|month
//
// B6 — an inside-sales rep's own numbers. Twin of the ASM route: `spoc_id` is
// never read from the query string, it is always the caller, so the builder
// never produces section E. For a rep the "calls" columns are the substance
// (lead_touchpoints.performed_by); the visit columns count any visit rows
// stamped with their id as asm_id, which is normally none.

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

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(["inside_sales_rep"]);

    let params;
    try {
        params = parseSalesDashboardParams(new URL(req.url));
    } catch (e) {
        if (e instanceof z.ZodError) {
            return errorResponse(e.issues[0]?.message ?? "Invalid query.", 400);
        }
        throw e;
    }

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
        // Pinned to the session, never to the URL.
        spoc_id: user.id,
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
