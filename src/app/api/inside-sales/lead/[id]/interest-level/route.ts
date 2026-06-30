// PATCH /api/inside-sales/lead/[id]/interest-level
// BRD §0.7 — lets an owner (or ASM/admin) override a lead's interest level
// (hot/warm/cold) independent of the lifecycle status. Each change is recorded
// in interest_level_overrides for audit (E-123). Reason is optional from the
// UI; a default is stored so the audit row's NOT NULL reason is satisfied.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { dealerLeads, interestLevelOverrides } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

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

        const existing = await db
            .select({ interest_level: dealerLeads.interest_level })
            .from(dealerLeads)
            .where(sql`${dealerLeads.id} = ${id}`)
            .limit(1);
        if (existing.length === 0) return errorResponse("Lead not found", 404);

        const fromValue = existing[0].interest_level;
        if (fromValue === body.interest_level) {
            // No-op: already at this level. Return success without an audit row.
            return successResponse({ interest_level: body.interest_level, changed: false });
        }

        const now = new Date();
        await db.transaction(async (tx) => {
            await tx
                .update(dealerLeads)
                .set({ interest_level: body.interest_level, updated_at: now })
                .where(sql`${dealerLeads.id} = ${id}`);

            await tx.insert(interestLevelOverrides).values({
                dealer_lead_id: id,
                from_value: fromValue ?? null,
                to_value: body.interest_level,
                reason: body.reason?.trim() || "Manual temperature change",
                changed_by: user.id,
                changed_at: now,
            });
        });

        return successResponse({ interest_level: body.interest_level, changed: true });
    },
);
