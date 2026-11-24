// GET /api/team/leads — 24 Nov (CRM item 5): the leads team members own, with
// each lead's latest action and latest comment. ?format=csv downloads it.
// Filters: member, status, business_type, city, q, from/to (latest action, IST).
// Scope: lib/team/teamLeads.ts (oversight roles: everyone; else self + reports).

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { listTeamLeads, teamScopeFor, TEAM_EXPORT_LIMIT } from "@/lib/team/teamLeads";
import { teamFiltersFromParams, istToday } from "@/lib/team/teamFilters";
import { csvResponse, teamLeadsCsv } from "@/lib/team/teamCsv";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    const sp = new URL(req.url).searchParams;
    const scope = await teamScopeFor(user);
    const filters = teamFiltersFromParams(sp);
    if (sp.get("format") === "csv") {
        const { rows, truncated } = await listTeamLeads(scope, filters, TEAM_EXPORT_LIMIT);
        return csvResponse(teamLeadsCsv(rows, truncated), `team-leads-${istToday()}.csv`);
    }
    const { rows, truncated } = await listTeamLeads(scope, filters);
    return successResponse({ rows, truncated, people: scope.people, all: scope.all });
});
