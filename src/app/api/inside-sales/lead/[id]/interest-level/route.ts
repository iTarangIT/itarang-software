// PATCH /api/inside-sales/lead/[id]/interest-level
// BRD §0.7 — lets an owner (or ASM/admin) override a lead's interest level
// (hot/warm/cold) independent of the lifecycle status. Each change is recorded
// in interest_level_overrides for audit (E-123) — see setInterestLevel(), shared
// with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { setInterestLevel } from "@/lib/leads/interestLevel";

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
