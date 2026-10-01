// POST /api/inside-sales/lead/[id]/commercials
// Create a new versioned commercials row (BRD §0.10). Flips prior is_current
// to false and inserts version_no = max+1 atomically. If event_type is a
// quote_issue/quote_revision, also writes a touchpoint of type 'quote_sent';
// if brochure_share, sets dealer_leads.brochure_sent_at on first event.
//
// The write itself lives in lib/leads/createCommercial.ts — shared with the
// WhatsApp Assistant's create_quote, so both go through one gate.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { COMMERCIAL_EVENT_TYPES, createLeadCommercial } from "@/lib/leads/createCommercial";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    event_type: z.enum(COMMERCIAL_EVENT_TYPES),
    price_quoted: z.number().nonnegative().nullable().optional(),
    quote_document_url: z.string().url().max(2000).nullable().optional(),
    brochure_url: z.string().url().max(2000).nullable().optional(),
    credit_terms: z.string().max(2000).nullable().optional(),
    delivery_terms: z.string().max(2000).nullable().optional(),
    warranty_terms: z.string().max(2000).nullable().optional(),
    final_price: z.number().nonnegative().nullable().optional(),
    payment_method: z.enum(["cash", "finance"]).nullable().optional(),
    deal_notes: z.string().max(5000).nullable().optional(),
    // Structured product line-items (E-128) — sourced from product_master_*.
    product_lines: z
        .array(
            z.object({
                asset_type: z.enum(["battery", "charger", "paraphernalia"]),
                product_id: z.string().min(1),
                product_name: z.string().min(1).max(200),
                model_id: z.string().max(100),
                unit_price: z.number().nonnegative().nullable(),
                quantity: z.number().int().positive().max(100000),
            }),
        )
        .max(100)
        .optional(),
    notes: z.string().max(5000).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const outcome = await createLeadCommercial({
            leadId: id,
            actor: { id: user.id, name: user.name ?? user.email ?? null },
            body,
        });
        // Draft PDF, paired touchpoint and notifications — after the commit.
        await outcome.afterCommit();

        // The modal tells the rep what happened to their quote — released, or
        // waiting and why. Without this they would have to guess from the
        // badge whether the dealer has seen it.
        return successResponse({
            commercial_id: outcome.commercialId,
            approval_status: outcome.approvalStatus,
            auto_approved: outcome.autoApproved,
            oem_evaluation: outcome.evaluation,
        });
    },
);
