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
import {
    assignAfterPush,
    resolveNeodoveAssignee,
} from "@/lib/neodove/assignAfterPush";

export const runtime = "nodejs";

const bodySchema = z.object({
    campaignId: z.string().trim().min(1, "campaignId is required"),
    // Escape hatch for a deliberate hand-off of an actively-worked lead. Not a
    // default: it has to be an explicit, auditable choice.
    force: z.boolean().optional(),
    // Omitted = use the campaign's default CRM owner, null = don't assign,
    // a string = override for this push (E-237).
    assignToUserId: z.string().trim().min(1).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        const actor = await requireRole(NEODOVE_ADMIN_ROLES);
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

        // Resolved before the push so an unassignable target is a 400 rather
        // than a lead that reached NeoDove and then failed to find an owner.
        const assignee = await resolveNeodoveAssignee({
            campaignId: parsed.data.campaignId,
            assignToUserId: parsed.data.assignToUserId,
        });
        if (!assignee.ok) {
            return errorResponse(assignee.message, assignee.status);
        }

        const result = await pushOneLead({
            leadId: id,
            campaignId: parsed.data.campaignId,
            force: parsed.data.force,
        });

        // Assign whenever the push was actually ATTEMPTED — that is `ok`, or a
        // 502 where the request left here and failed at NeoDove's end. The
        // other failures (404 unknown lead, 409 actively-worked, 400 no valid
        // mobile) are refusals before anything was sent, and assigning on those
        // would hand a rep a lead nobody has taken.
        const attempted = result.ok || result.status === 502;
        let assigned = false;
        if (assignee.target && attempted) {
            assigned = await assignAfterPush({
                leadId: id,
                campaignId: parsed.data.campaignId,
                target: assignee.target,
                actorId: actor.id,
                actorRole: actor.role,
                campaignLabel:
                    (result.ok ? result.campaignName : null) ??
                    parsed.data.campaignId,
            });
        }

        if (!result.ok) return errorResponse(result.message, result.status);
        return successResponse({
            pushed: true,
            neodoveLeadId: result.neodoveLeadId,
            assigned,
            assignedTo: assigned && assignee.target ? assignee.target.name : null,
        });
    },
);
