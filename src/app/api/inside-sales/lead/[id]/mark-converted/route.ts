// POST /api/inside-sales/lead/[id]/mark-converted
// BRD §0.7 + §0.10 — terminal Converted. Hard validation: final_price MUST be
// set on the current commercials row. Onboarding application row creation is
// deferred to Module 3.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { canTransition, type LeadStatus } from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

// BRD §0.13 closing_role audit — derived from actor role.
function deriveClosingRole(role: string): "is_phone" | "asm_visit" | "admin" {
    if (role === "asm") return "asm_visit";
    if (role === "admin") return "admin";
    return "is_phone";
}

const BodySchema = z.object({
    notes: z.string().max(5000).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const rows = await db.execute<{
            lead_status: string | null;
            final_price: string | null;
        }>(sql`
            SELECT
                dl.lead_status,
                (SELECT final_price::text FROM dealer_lead_commercials c WHERE c.dealer_lead_id = dl.id AND c.is_current = true LIMIT 1) AS final_price
            FROM dealer_leads dl WHERE dl.id = ${id} LIMIT 1
        `);
        const state = rows[0];
        if (!state) return errorResponse("Lead not found", 404);
        const fromStatus = state.lead_status as LeadStatus | null;
        if (!fromStatus) return errorResponse("Lead has no status", 400);

        const t = canTransition(fromStatus, "Converted", {
            finalPrice: state.final_price === null ? null : Number(state.final_price),
            actorRole: user.role,
        });
        if (!t.ok) return errorResponse(t.reason, 400);

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "status_change_note",
            performedBy: user.id,
            remarks: body.notes ?? "Marked Converted",
            statusChange: {
                from: fromStatus,
                to: "Converted",
                reasonNotes: body.notes ?? null,
                closingRole: deriveClosingRole(user.role),
            },
        });

        return successResponse({ ok: true });
    },
);
