// GET /api/inside-sales/lead/[id]
// Full bundle for Lead Detail — see fetchLeadDetailBundle(), shared with the
// WhatsApp Assistant.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchLeadDetailBundle } from "@/lib/inside-sales/leadDetail";
import { readsOwnLeadsOnly } from "@/lib/leads/access";
import { leadOwnedBy } from "@/lib/ai-dialer/campaignAccess";

export const dynamic = "force-dynamic";

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

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        // ID 45: a rep reads only leads they own; anything else is "no such lead".
        if (readsOwnLeadsOnly(user.role) && !(await leadOwnedBy(id, user.id))) {
            return errorResponse("Lead not found", 404);
        }

        const bundle = await fetchLeadDetailBundle(id);
        if (!bundle) return errorResponse("Lead not found", 404);
        return successResponse(bundle);
    },
);
