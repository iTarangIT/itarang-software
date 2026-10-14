// /api/me/team-targets — ID 156: a manager's team against the manager's own
// target, month to date.
//
//   GET ?month=YYYY-MM   the caller's pushed / accepted targets, with the actual
//                        = their own + each direct report's for the days they
//                        were in the team (src/lib/admin/teamPerformance.ts).
//                        Empty rows for anyone without a team.

import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { teamTargets } from "@/lib/admin/teamPerformance";
import { getTeamMemberIds } from "@/lib/users/team";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-\d{2}$/;

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const m = new URL(req.url).searchParams.get("month") ?? "";
    const month = MONTH.test(m) ? m : new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    if ((await getTeamMemberIds(user.id)).length === 0) {
        return successResponse({ month, rows: [], context: null, members: [] });
    }
    return successResponse({ month, ...(await teamTargets(user.id, month)) });
});
