// GET /api/admin/reports/funnel-counts
//   ?from=&to=&city=&state=&dealer_id=&nbfc_id=&group_by=none|city|state|month|dealer|nbfc[&format=csv]
//
// B10 — dealers onboarded, KYC files shared, files disbursed, files rejected
// (with reasons), sliced and filtered. See src/lib/admin/funnelCounts.ts for
// what each count means and which filters touch which count.
//
// Lives beside sales-dashboard, outside the [type] catalogue route, because it
// returns a multi-part object (totals + reasons + rows), not the flat
// ReportResult the reports hub tabulates.

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { buildFunnelCounts, funnelCountsCsv, parseFunnelParams } from "@/lib/admin/funnelCounts";
import { csvResponse } from "@/lib/leads/queueCsv";

export const dynamic = "force-dynamic";

// sales_head added 2026-09-18 on request — the sales head owns the top of this funnel.
const READ_ROLES = ["admin", "ceo", "business_head", "finance_controller", "sales_head"];

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);

    let params;
    try {
        params = parseFunnelParams(new URL(req.url));
    } catch (e) {
        if (e instanceof z.ZodError) return errorResponse(e.issues[0]?.message ?? "Invalid query.", 400);
        throw e;
    }

    let result;
    try {
        result = await buildFunnelCounts(params);
    } catch (e) {
        if (e instanceof RangeError) return errorResponse(e.message, 400);
        throw e;
    }

    if (new URL(req.url).searchParams.get("format") === "csv") {
        const sheet = funnelCountsCsv(result);
        return csvResponse({
            rows: sheet.rows,
            columns: sheet.columns,
            filename: sheet.filename,
            total: sheet.rows.length,
        });
    }
    return successResponse(result);
});
