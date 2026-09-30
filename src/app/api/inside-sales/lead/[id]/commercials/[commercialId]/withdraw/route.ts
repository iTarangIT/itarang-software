// POST /api/inside-sales/lead/[id]/commercials/[commercialId]/withdraw  { reason }
// Withdraw quote (tracker ID 78): the lead's owner, or a manager, closes a
// stale quote with a reason. The write lives in withdrawQuote().

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { withdrawQuote } from "@/lib/leads/withdrawQuote";

const OWNER_ROLES = ["inside_sales_rep", "asm", "partner"];
const MANAGER_ROLES = ["admin", "ceo", "sales_head", "sales_manager", "business_head"];

const BodySchema = z.object({ reason: z.string().trim().min(5).max(1000) });

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string; commercialId: string }> }) => {
        const user = await requireRole([...OWNER_ROLES, ...MANAGER_ROLES]);
        const { id, commercialId } = await ctx.params;
        const { reason } = BodySchema.parse(await req.json());

        if (!MANAGER_ROLES.includes(user.role)) {
            const [lead] = (await db.execute<{ current_owner_id: string | null }>(sql`
                SELECT current_owner_id FROM dealer_leads WHERE id = ${id} LIMIT 1
            `)) as unknown as Array<{ current_owner_id: string | null }>;
            if (!lead) return errorResponse("Lead not found", 404);
            if (lead.current_owner_id !== user.id) {
                return errorResponse("Only the lead owner or a manager can withdraw its quote.", 403);
            }
        }

        const result = await withdrawQuote({ leadId: id, commercialId, actorId: user.id, reason });
        return successResponse(result);
    },
);
