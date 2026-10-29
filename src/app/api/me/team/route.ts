// /api/me/team — ID 199: the caller's direct reports (id + name) for the
// "Team member" pick on the Leads list. Empty for anyone without a team, and
// for roles that already see more than their own leads (they have the Owner
// filter instead).

import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { exportsOwnLeadsOnly } from "@/lib/leads/access";
import { getTeamPeople } from "@/lib/users/team";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireAuth();
    const people = exportsOwnLeadsOnly(user.role) ? await getTeamPeople(user.id) : [];
    return successResponse({ people });
});
