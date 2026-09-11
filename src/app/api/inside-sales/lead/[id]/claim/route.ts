// POST /api/inside-sales/lead/[id]/claim
// BRD §0.3 Path B — IS rep claims a lead from the New_Unassigned queue.
// Sets current_owner_id + originator_id (if NULL) + lead_status → Assigned_Not_Contacted.
// The work lives in claimLead so the bulk route shares it exactly.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { CLAIM_ROLES, claimLead } from "@/lib/inside-sales/claimLead";

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...CLAIM_ROLES]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const outcome = await claimLead(id, user.id);
        if (!outcome.ok) {
            switch (outcome.reason) {
                case "not_found":
                    return errorResponse("Lead not found", 404);
                case "already_owned":
                    return errorResponse(
                        "Lead has already been claimed by another rep.",
                        409,
                    );
                case "terminal":
                    return errorResponse("Lead is no longer claimable (closed).", 409);
            }
        }

        return successResponse({ ok: true });
    },
);
