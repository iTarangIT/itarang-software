// POST /api/admin/leads/[id]/repair-number  { new_phone?, note }
// Number Repair (tracker ID 36): fix a dead / non-responsive lead's number (or
// confirm it) and put the lead back into the working queues. The lead's owner
// of record, a manager or an admin may do it.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { repairLeadNumber } from "@/lib/leads/contactability";

const MANAGERS = ["admin", "ceo", "sales_head", "sales_manager", "business_head"];
const REPS = ["inside_sales_rep", "asm", "partner"];

const BodySchema = z.object({
    new_phone: z.string().trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits").nullable().optional(),
    note: z.string().trim().min(3).max(500),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...MANAGERS, ...REPS]);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());
        if (!MANAGERS.includes(user.role)) {
            const [lead] = (await db.execute<{ current_owner_id: string | null }>(sql`
                SELECT current_owner_id FROM dealer_leads WHERE id = ${id} LIMIT 1
            `)) as unknown as Array<{ current_owner_id: string | null }>;
            if (!lead) return errorResponse("Lead not found", 404);
            if (lead.current_owner_id !== user.id) return errorResponse("Only the lead owner or a manager can repair its number.", 403);
        }
        await repairLeadNumber({ leadId: id, actorId: user.id, newPhone: body.new_phone ?? null, note: body.note });
        return successResponse({ ok: true });
    },
);
