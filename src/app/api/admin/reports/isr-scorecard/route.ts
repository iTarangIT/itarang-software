// GET /api/admin/reports/isr-scorecard?from&to&state — the Sales Head
// scorecard's Inside sales (ISR) tab figures (src/lib/admin/isrScorecard.ts),
// keyed by user id. Same readers as the sales dashboard.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { buildIsrScorecard } from "@/lib/admin/isrScorecard";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const p = new URL(req.url).searchParams;
    const from = p.get("from") ?? "";
    const to = p.get("to") ?? "";
    if (!ISO.test(from) || !ISO.test(to) || from > to) return errorResponse("from / to must be YYYY-MM-DD, from ≤ to.", 400);
    return successResponse(await buildIsrScorecard({ from, to, state: p.get("state")?.trim() || null }));
});
