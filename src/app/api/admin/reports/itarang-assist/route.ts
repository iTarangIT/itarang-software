// GET /api/admin/reports/itarang-assist?from&to&state&city — ID 183: the
// iTarang team's credit for customer files worked for the dealer, on the Team
// scorecard (src/lib/admin/itarangAssistScore.ts). Same readers as the
// ISR scorecard.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { buildItarangAssistScore } from "@/lib/admin/itarangAssistScore";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const p = new URL(req.url).searchParams;
    const from = p.get("from") ?? "";
    const to = p.get("to") ?? "";
    if (!ISO.test(from) || !ISO.test(to) || from > to) return errorResponse("from / to must be YYYY-MM-DD, from ≤ to.", 400);
    return successResponse(
        await buildItarangAssistScore({ from, to, state: p.get("state")?.trim() || null, city: p.get("city")?.trim() || null }),
    );
});
