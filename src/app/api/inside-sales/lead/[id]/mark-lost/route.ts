// POST /api/inside-sales/lead/[id]/mark-lost
// BRD §0.7 — terminal Lost with mandatory reason. High-impact reasons require
// confirmed_high_impact=true (client shows the consequence modal first). The
// write lives in markLeadLost(), shared with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { LOST_REASON } from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";
import {
    HighImpactUnconfirmedError,
    LostLeadNotFoundError,
    LostNotesRequiredError,
    markLeadLost,
} from "@/lib/leads/markLost";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    lost_reason: z.enum(LOST_REASON),
    lost_reason_notes: z.string().max(5000).nullable().optional(),
    confirmed_high_impact: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            await markLeadLost({
                leadId: id,
                actor: { id: user.id, role: user.role },
                reason: body.lost_reason,
                notes: body.lost_reason_notes ?? null,
                confirmedHighImpact: body.confirmed_high_impact,
            });
        } catch (err) {
            if (err instanceof LostNotesRequiredError || err instanceof HighImpactUnconfirmedError) {
                return errorResponse(err.message, 400);
            }
            if (err instanceof LostLeadNotFoundError) return errorResponse("Lead not found", 404);
            throw err;
        }

        return successResponse({ ok: true });
    },
);
