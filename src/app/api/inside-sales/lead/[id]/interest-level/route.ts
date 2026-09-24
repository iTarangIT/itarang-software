// PATCH /api/inside-sales/lead/[id]/interest-level
// BRD §0.7 — lets the lead's OWNER override its interest level (hot/warm/cold)
// independent of the lifecycle status. Owner-only since the WhatsApp Assistant
// BRD §2.3-3: this was the one mutate route on a dealer_lead without
// assertOwner, so any ISR/ASM/admin could re-rate anyone's lead. Each change is recorded
// in interest_level_overrides for audit (E-123) — see setInterestLevel(), shared
// with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { assertOwner, ForbiddenLeadAccessError } from "@/lib/leads/ownership";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    interest_level: z.enum(["hot", "warm", "cold"]),
    reason: z.string().trim().max(500).optional().nullable(),
});

export const PATCH = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        try {
            await assertOwner(id, user.id);
        } catch (err) {
            // ForbiddenLeadAccessError carries no HTTP status, so withErrorHandler
            // would turn it into a 500. It is a permission refusal.
            if (err instanceof ForbiddenLeadAccessError) {
                return errorResponse("Only the lead's owner can change its interest level.", 403);
            }
            throw err;
        }

        const result = await setInterestLevel({
            leadId: id,
            actorId: user.id,
            level: body.interest_level,
            reason: body.reason,
        });
        if (!result) return errorResponse("Lead not found", 404);

        return successResponse({ interest_level: body.interest_level, changed: result.changed });
    },
);
