// POST /api/neodove/leads/[id]/push
//
// Send one lead to a NeoDove campaign — the "hand this one to the calling team"
// action on a lead row. Synchronous (one HTTP call, already timeout-bounded in
// the client) so the operator gets a real answer rather than an optimistic one.
//
// The push itself, the BRD §0.2 exclusion check and all four bookkeeping writes
// live in pushOneLead() — shared verbatim with the priority-dial route, which
// runs the identical sequence and would otherwise be a second copy of it free
// to drift. What stays here is only what is specific to this endpoint: its role
// gate, its body shape and its response.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { getNeodoveConfig } from "@/lib/neodove/config";
import { pushOneLead } from "@/lib/neodove/pushOne";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";

const bodySchema = z.object({
    campaignId: z.string().trim().min(1, "campaignId is required"),
    // Escape hatch for a deliberate hand-off of an actively-worked lead. Not a
    // default: it has to be an explicit, auditable choice.
    force: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        if (!getNeodoveConfig().enabled) {
            return errorResponse("NeoDove integration is disabled.", 409);
        }

        const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
            return errorResponse(
                parsed.error.issues.map((i) => i.message).join("; "),
                400,
            );
        }

        const result = await pushOneLead({
            leadId: id,
            campaignId: parsed.data.campaignId,
            force: parsed.data.force,
        });

        if (!result.ok) return errorResponse(result.message, result.status);
        return successResponse({
            pushed: true,
            neodoveLeadId: result.neodoveLeadId,
        });
    },
);
