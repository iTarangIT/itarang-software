// POST /api/inside-sales/lead/[id]/mark-converted
// BRD §0.7 — terminal Converted, settable from any status: the funnel-order and
// final_price gates are gone (a deal can close on the first call, and a lead
// closed by mistake has to be recoverable). On success it also creates the draft
// dealer_onboarding_applications row (BRD §0.13 Point A). The write lives in
// lib/leads/markConverted.ts, shared with the WhatsApp Assistant.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";
import { ConvertLeadNotFoundError, markLeadConverted } from "@/lib/leads/markConverted";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

// GSTIN is REQUIRED here (review R-11): it is the only reliable key from a
// dealer's invoices back to this lead, and so to the SPOC who closed it. The
// customer name typed on an invoice cannot be joined to anything. Other paths
// to Converted (admin bulk status, NeoDove) cannot ask for it; those leads show
// up as unlinked on the Sales Invoices reconciliation filter.
const BodySchema = z.object({
    notes: z.string().max(5000).nullable().optional(),
    gstin: z
        .string()
        .transform(normalizeGstin)
        .refine(isValidGstin, "Enter the dealer's 15-character GSTIN (e.g. 07AAACB1234C1Z5)."),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            const { applicationId, notify } = await markLeadConverted({
                leadId: id,
                actor: { id: user.id, name: user.name, role: user.role },
                gstin: body.gstin,
                notes: body.notes,
            });
            await notify();
            return successResponse({ ok: true, onboardingApplicationId: applicationId });
        } catch (err) {
            if (err instanceof ConvertLeadNotFoundError) return errorResponse("Lead not found", 404);
            throw err;
        }
    },
);
