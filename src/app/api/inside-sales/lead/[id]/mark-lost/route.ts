// POST /api/inside-sales/lead/[id]/mark-lost
// BRD §0.7 — terminal Lost with mandatory reason. High-impact reasons require
// confirmed_high_impact=true (client shows the consequence modal first).

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import {
    LOST_REASON,
    isHighImpactLostReason,
    type LeadStatus,
} from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

// BRD §0.13 closing_role audit:
//   is_phone        — IS rep closed via phone workflow
//   asm_visit       — ASM closed via ground visit
//   is_post_handoff — IS rep got the lead back after handoff (admin reassign)
//   admin / system  — reserved for admin loopback + automated paths
function deriveClosingRole(role: string): "is_phone" | "asm_visit" | "admin" {
    if (role === "asm") return "asm_visit";
    if (role === "admin") return "admin";
    return "is_phone";
}

const BodySchema = z.object({
    lost_reason: z.enum(LOST_REASON),
    lost_reason_notes: z.string().max(5000).nullable().optional(),
    confirmed_high_impact: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        if (body.lost_reason === "other" && !body.lost_reason_notes?.trim()) {
            return errorResponse(
                "lost_reason_notes is required when lost_reason = 'other'.",
                400,
            );
        }

        if (
            isHighImpactLostReason(body.lost_reason) &&
            !body.confirmed_high_impact
        ) {
            return errorResponse(
                "High-impact lost reason requires explicit confirmation.",
                400,
            );
        }

        const stateRows = await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `);
        if (stateRows.length === 0) return errorResponse("Lead not found", 404);
        // Reachable from ANY status, for any role — a Converted lead (the
        // onboarding-dropout loopback, no longer admin-only) and a lead with no
        // status included. The reason itself is still mandatory.
        const fromStatus = stateRows[0]?.lead_status as LeadStatus | null;

        // BRD §0.7 side effect: business_closed permanently excludes from AI dialer.
        if (body.lost_reason === "business_closed") {
            await db.execute(sql`
                UPDATE dealer_leads SET ai_recall_status = 'excluded', updated_at = NOW() WHERE id = ${id}
            `);
        }

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "status_change_note",
            performedBy: user.id,
            remarks: body.lost_reason_notes ?? `Marked Lost — ${body.lost_reason}`,
            statusChange: {
                from: fromStatus,
                to: "Lost",
                toLostReason: body.lost_reason,
                reasonNotes: body.lost_reason_notes ?? null,
                closingRole: deriveClosingRole(user.role),
            },
        });

        return successResponse({ ok: true });
    },
);
