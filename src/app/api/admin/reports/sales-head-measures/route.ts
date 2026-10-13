// GET /api/admin/reports/sales-head-measures?from&to[&state&city&business_type&spoc_id]
// — tracker ID 88: the Sales dashboard figures that used to say "not tracked
// yet" (speed, stuck over 7 days, engaged and WhatsApp shares, verified visits,
// quote boxes, stage lost at) and the batteries estimate for invoices with no
// item lines. src/lib/dashboard/salesHeadMeasures.ts; each block is null when
// its source is missing on this database.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { measureFiltersFrom, salesHeadMeasures } from "@/lib/dashboard/salesHeadMeasures";

export const dynamic = "force-dynamic";

// The roles that read the Sales dashboard (as /api/admin/reports/needs-action).
const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const f = measureFiltersFrom(new URL(req.url).searchParams);
    if (!f) return errorResponse("from / to must be YYYY-MM-DD, from ≤ to.", 400);
    return successResponse(await salesHeadMeasures(f));
});
