// GET /api/inside-sales/lead/[id]/calls
// The lead page's "Calls" tab (NeoDove task, 26 Nov): every human call on the
// lead — logged in the CRM or sent by NeoDove — newest first, with when it
// happened, who made it, connected or not, NeoDove's status / stage / outcome /
// follow-up date, duration and recording. src/lib/leads/leadCallHistory.ts.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadLeadCalls } from "@/lib/leads/leadCallHistory";
import { readsOwnLeadsOnly } from "@/lib/leads/access";
// ID 155: read access = own leads, or a direct report's (manager).
import { leadVisibleTo } from "@/lib/users/team";

export const dynamic = "force-dynamic";

// Same readers as the lead detail bundle and the AI calls tab.
const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(READ_ROLES);
    const { id } = await ctx.params;
    if (!id) return errorResponse("Lead id required", 400);
    // ID 45: a rep reads only leads they own; anything else is "no such lead".
    if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
        return errorResponse("Lead not found", 404);
    }
    return successResponse(await loadLeadCalls(id));
});
