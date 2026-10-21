// GET /api/admin/reports/needs-action — the Sales Head "Needs action now"
// tiles beyond idle leads and dealer health (src/lib/dashboard/salesHeadActions.ts).
// Takes the dashboard's filters: state, spoc_id (person), team (field|inside),
// and (ID 190) from / to — the "Waiting for a field visit" tile then counts the
// leads still waiting at the end of that period, against the previous one.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { actionScopeFrom, salesHeadActionSummary } from "@/lib/dashboard/salesHeadActions";
import { dayOr, fieldVisitCard } from "@/lib/dashboard/fieldVisitTrend";

export const dynamic = "force-dynamic";

// The roles that read the Sales Head screen (/sales-head and /admin/reports/sales-dashboard).
const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(VIEW_ROLES);
    // ID 174: the viewer's role decides role-limited tiles (Stock to upload).
    const p = new URL(req.url).searchParams;
    const scope = actionScopeFrom(p);
    const summary = await salesHeadActionSummary({ ...scope, viewerRole: user.role });
    const from = dayOr(p.get("from"), "");
    const to = dayOr(p.get("to"), "");
    if (from && to && summary.visit_overdue) {
        try {
            const card = await fieldVisitCard(scope, from, to);
            summary.visit_overdue = { count: card.count, sub: card.sub };
        } catch (e) {
            // Keep the live count when the period query fails on this database.
            console.warn("[needs-action] field-visit period card skipped:", e instanceof Error ? e.message : e);
        }
    }
    return successResponse(summary);
});
