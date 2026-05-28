// GET /api/admin/reports/[type]?date_from=&date_to=[&format=csv]
// The 6 pre-canned reports (BRD §0.11). Returns JSON, or a CSV download when
// format=csv.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { runReport, toCsv } from "@/lib/admin/reports";
import { parseDashboardFilters } from "@/lib/admin/filters";
import { REPORT_TYPES } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo"];
const TypeSchema = z.enum(REPORT_TYPES);

export const GET = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ type: string }> }) => {
        await requireRole(READ_ROLES);
        const { type } = await ctx.params;
        const parsed = TypeSchema.safeParse(type);
        if (!parsed.success) return errorResponse("Unknown report type.", 400);

        const url = new URL(req.url);
        const filters = parseDashboardFilters(url);
        const result = await runReport(parsed.data, filters);

        if (url.searchParams.get("format") === "csv") {
            return new Response(toCsv(result), {
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${parsed.data}_report.csv"`,
                },
            });
        }

        return successResponse(result);
    },
);
