// POST /api/inside-sales/lead/[id]/reassign
// BRD §0.3 Path C — owner-initiated reassignment with mandatory reason
// (≥ 20 chars). Follow-up carries forward unchanged.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { assertOwner } from "@/lib/leads/ownership";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

const BodySchema = z.object({
    target_user_id: z.string().min(1),
    reason: z.string().min(20).max(5000),
    notify_admin: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        if (body.target_user_id === user.id) {
            return errorResponse("Cannot reassign to yourself.", 400);
        }

        const targets = await db.execute<{ id: string; role: string | null; is_active: boolean | null }>(sql`
            SELECT id::text AS id, role, is_active FROM users WHERE id::text = ${body.target_user_id} LIMIT 1
        `);
        const target = targets[0];
        if (!target) return errorResponse("Target user not found.", 404);
        if (target.is_active === false) {
            return errorResponse("Target user is inactive.", 400);
        }

        await db.execute(sql`
            UPDATE dealer_leads
            SET current_owner_id = ${body.target_user_id},
                assigned_at = NOW(),
                updated_at = NOW()
            WHERE id = ${id}
        `);

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "ownership_transfer",
            performedBy: user.id,
            remarks: body.reason,
        });

        return successResponse({ ok: true, notify_admin: !!body.notify_admin });
    },
);
