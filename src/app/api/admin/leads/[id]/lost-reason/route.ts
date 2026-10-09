// POST /api/admin/leads/[id]/lost-reason
//   { lost_reason, note, competitor_name? }
//
// Tracker ID 136 (decided 3 Oct 2026): "Change Lost reason" for the Sales Head
// and admin — what replaced "Correct status" for a Lost lead recorded with the
// wrong reason. The lead stays Lost (status, closed date, closing owner
// unchanged); the history records old → new reason. Rules in changeLostReason.ts.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LOST_REASON } from "@/lib/lifecycle/transitions";
import { LOST_REASON_CHANGE_ROLES, changeLostReason } from "@/lib/leads/changeLostReason";

const BodySchema = z.object({
    lost_reason: z.enum(LOST_REASON),
    note: z.string().trim().min(5).max(2000),
    competitor_name: z.string().trim().max(200).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...LOST_REASON_CHANGE_ROLES]);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());

        // Throws LostReasonChangeError (400 / 404 / 409) before anything is written.
        const result = await changeLostReason({
            leadId: id,
            actor: { id: user.id, role: user.role },
            to: body.lost_reason,
            competitorName: body.competitor_name,
            note: body.note,
        });
        return successResponse(result);
    },
);
