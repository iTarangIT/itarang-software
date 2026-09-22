// GET /api/admin/reports/owner-leads?person_id=&metric=&date_from=&date_to=
// Funnel-by-Owner drill-down: the leads behind one clicked cell. Same role gate
// and date filters as the report itself (../[type]/route.ts).

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { funnelByOwnerLeads } from "@/lib/admin/reports";
import { parseDashboardFilters } from "@/lib/admin/filters";
import { OWNER_DRILL_METRICS } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo", "partner"];
const QuerySchema = z.object({
    person_id: z.string().min(1).max(100),
    metric: z.enum(OWNER_DRILL_METRICS),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
        person_id: url.searchParams.get("person_id"),
        metric: url.searchParams.get("metric"),
    });
    if (!parsed.success) return errorResponse("Invalid person or metric.", 400);

    const leads = await funnelByOwnerLeads(
        parsed.data.person_id,
        parsed.data.metric,
        parseDashboardFilters(url),
    );
    return successResponse({ leads });
});
