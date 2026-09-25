// POST /api/inside-sales/lead/[id]/transfer-asm
// BRD §0.8 — hand off to an ASM. ASM picker may be territory-filtered; out-of-
// territory requires a reason. The write itself lives in
// lib/leads/transferToAsm.ts, shared with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import {
    TRANSFER_REASONS,
    TransferLeadNotFoundError,
    VISIT_TYPES,
    transferLeadToAsm,
} from "@/lib/leads/transferToAsm";

const MUTATE_ROLES = ["inside_sales_rep", "admin", "partner"];

const BodySchema = z.object({
    asm_id: z.string().min(1),
    reason: z.enum(TRANSFER_REASONS),
    visit_type: z.enum(VISIT_TYPES),
    suggested_visit_date: z.string().date().nullable().optional(),
    dealer_preferred_time: z.string().max(200).nullable().optional(),
    handoff_notes: z.string().max(5000).optional().default(""),
    pending_items: z.array(z.string()).max(10).optional(),
    out_of_territory_reason: z.string().max(1000).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            await transferLeadToAsm({
                leadId: id,
                actorId: user.id,
                asmId: body.asm_id,
                reason: body.reason,
                visitType: body.visit_type,
                suggestedVisitDate: body.suggested_visit_date,
                dealerPreferredTime: body.dealer_preferred_time,
                handoffNotes: body.handoff_notes,
                pendingItems: body.pending_items,
                outOfTerritoryReason: body.out_of_territory_reason,
            });
        } catch (err) {
            if (err instanceof TransferLeadNotFoundError) return errorResponse("Lead not found", 404);
            throw err;
        }

        return successResponse({ ok: true });
    },
);
