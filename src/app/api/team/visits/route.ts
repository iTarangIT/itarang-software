// GET /api/team/visits?kind=scheduled|completed — 24 Nov (CRM item 7).
// Scheduled and completed visits are SEPARATE lists, each over its own date
// range: scheduled_date for "scheduled", actual_visit_date (done visits) for
// "completed". ?format=csv downloads the list. Other filters: member, city,
// business_type. Scope: lib/team/teamLeads.ts.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { listTeamVisits, teamScopeFor, TEAM_EXPORT_LIMIT } from "@/lib/team/teamLeads";
import { isVisitKind, teamFiltersFromParams } from "@/lib/team/teamFilters";
import { csvResponse, teamVisitsCsv } from "@/lib/team/teamCsv";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    const sp = new URL(req.url).searchParams;
    const kind = sp.get("kind") ?? "scheduled";
    if (!isVisitKind(kind)) return errorResponse("kind must be scheduled or completed", 400);
    const scope = await teamScopeFor(user);
    const filters = teamFiltersFromParams(sp);
    if (sp.get("format") === "csv") {
        const r = await listTeamVisits(scope, kind, filters, TEAM_EXPORT_LIMIT);
        return csvResponse(teamVisitsCsv(r.rows, r.truncated), `${kind}-visits-${r.from}-to-${r.to}.csv`);
    }
    const r = await listTeamVisits(scope, kind, filters);
    return successResponse({ ...r, kind, people: scope.people, all: scope.all });
});
