// POST /api/inside-sales/lead/[id]/escalate
// BRD §0.6 — raise an escalation. Owner remains unchanged; admin resolves
// (Module 3). The write lives in lib/leads/escalate.ts, shared with the
// WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import {
    ALL_ESCALATION_REASONS,
    ESCALATION_NOTES_MIN,
    ESCALATION_URGENCIES,
    EscalateError,
    escalateLead,
} from "@/lib/leads/escalate";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    escalation_reason: z.enum(ALL_ESCALATION_REASONS),
    escalation_notes: z.string().min(ESCALATION_NOTES_MIN).max(5000),
    suggested_action: z.string().max(1000).nullable().optional(),
    urgency: z.enum(ESCALATION_URGENCIES),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            const { escalationId, notify } = await escalateLead({
                leadId: id,
                actor: { id: user.id, name: user.name },
                reason: body.escalation_reason,
                notes: body.escalation_notes,
                suggestedAction: body.suggested_action,
                urgency: body.urgency,
            });
            await notify();
            return successResponse({ escalation_id: escalationId });
        } catch (err) {
            if (err instanceof EscalateError) return errorResponse(err.message, err.status);
            throw err;
        }
    },
);
