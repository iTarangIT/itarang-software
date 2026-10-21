// GET /api/admin/reports/needs-action/[key] — one "Needs action now" list as a
// CSV download, with the list page's filters (q, state, spoc_id, team), so the
// file holds exactly the rows on screen. `?format=json` returns them as JSON.

import { requireAuth } from "@/lib/auth-utils";
import { needsActionAccess } from "@/lib/dashboard/needsActionAccess";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { csvResponse } from "@/lib/leads/queueCsv";
import {
    actionCsvColumns,
    ACTION_KEYS,
    actionKeyVisibleTo,
    actionScopeFrom,
    listSalesHeadAction,
    listSalesHeadActionFiltered,
    searchActionRows,
    type ActionKey,
} from "@/lib/dashboard/salesHeadActions";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const user = await requireAuth();
    const { key } = await ctx.params;
    if (!(ACTION_KEYS as readonly string[]).includes(key)) return errorResponse("Unknown list.", 400);
    if (!actionKeyVisibleTo(key as ActionKey, user.role)) return errorResponse("Not allowed.", 403);
    // ID 190: the page's readers, plus a manager with reporting lines for
    // "Waiting for a field visit" — scoped to their team.
    const access = await needsActionAccess(user, key);
    if (access.kind === "none") return errorResponse("Not allowed.", 403);

    const p = new URL(req.url).searchParams;
    const rows =
        access.kind === "team"
            ? searchActionRows(await listSalesHeadAction(key as ActionKey, { ...actionScopeFrom(p), teamIds: access.teamIds }), p.get("q"))
            : await listSalesHeadActionFiltered(key as ActionKey, p);
    if (p.get("format") === "json") return successResponse({ key, rows });
    return csvResponse({
        rows,
        columns: actionCsvColumns(key as ActionKey),
        filename: `needs-action-${key.replace(/_/g, "-")}`,
        total: rows.length,
    });
});
