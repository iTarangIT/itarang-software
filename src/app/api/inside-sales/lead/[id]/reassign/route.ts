// POST /api/inside-sales/lead/[id]/reassign
// BRD §0.3 Path C — owner-initiated reassignment with mandatory reason
// (≥ 20 chars). Follow-up carries forward unchanged. The write lives in
// lib/leads/reassign.ts, shared with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { REASSIGN_REASON_MIN, ReassignError, reassignLead } from "@/lib/leads/reassign";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    target_user_id: z.string().min(1),
    reason: z.string().min(REASSIGN_REASON_MIN).max(5000),
    notify_admin: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            await reassignLead({
                leadId: id,
                actorId: user.id,
                targetUserId: body.target_user_id,
                reason: body.reason,
            });
        } catch (err) {
            if (err instanceof ReassignError) return errorResponse(err.message, err.status);
            throw err;
        }

        return successResponse({ ok: true, notify_admin: !!body.notify_admin });
    },
);
