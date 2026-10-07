// GET /api/admin/reports/needs-action/[key] — one "Needs action now" list as a
// CSV download, with the list page's filters (q, state, spoc_id, team), so the
// file holds exactly the rows on screen. `?format=json` returns them as JSON.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { csvResponse } from "@/lib/leads/queueCsv";
import {
    ACTION_CSV_COLUMNS,
    ACTION_KEYS,
    listSalesHeadActionFiltered,
    type ActionKey,
} from "@/lib/dashboard/salesHeadActions";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    await requireRole(VIEW_ROLES);
    const { key } = await ctx.params;
    if (!(ACTION_KEYS as readonly string[]).includes(key)) return errorResponse("Unknown list.", 400);

    const p = new URL(req.url).searchParams;
    const rows = await listSalesHeadActionFiltered(key as ActionKey, p);
    if (p.get("format") === "json") return successResponse({ key, rows });
    return csvResponse({
        rows,
        columns: ACTION_CSV_COLUMNS,
        filename: `needs-action-${key.replace(/_/g, "-")}`,
        total: rows.length,
    });
});
