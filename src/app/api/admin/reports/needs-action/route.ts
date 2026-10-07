// GET /api/admin/reports/needs-action — the Sales Head "Needs action now"
// tiles beyond idle leads and dealer health (src/lib/dashboard/salesHeadActions.ts).
// Takes the dashboard's filters: state, spoc_id (person), team (field|inside).

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { actionScopeFrom, salesHeadActionSummary } from "@/lib/dashboard/salesHeadActions";

export const dynamic = "force-dynamic";

// The roles that read the Sales Head screen (/sales-head and /admin/reports/sales-dashboard).
const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const summary = await salesHeadActionSummary(actionScopeFrom(new URL(req.url).searchParams));
    return successResponse(summary);
});
