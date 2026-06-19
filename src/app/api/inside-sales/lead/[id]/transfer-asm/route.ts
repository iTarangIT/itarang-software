// POST /api/inside-sales/lead/[id]/transfer-asm
// BRD §0.8 — hand off to an ASM. ASM picker may be territory-filtered; out-of-
// territory requires a reason. Writes asm_transfer touchpoint + status history,
// updates current_owner_id/asm_id/pre_transfer_status, creates a lead_visits row.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { canTransition, type LeadStatus } from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";

const MUTATE_ROLES = ["inside_sales_rep", "admin"];

const BodySchema = z.object({
    asm_id: z.string().min(1),
    reason: z.enum([
        "Commercials_Finalised",
        "Site_Visit_Needed",
        "Negotiation_Beyond_IS_Authority",
        "Demo_Requested",
        "Other",
    ]),
    visit_type: z.enum(["Initial_Visit", "Demo", "Negotiation", "Closing"]),
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

        const stateRows = await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${id} LIMIT 1
        `);
        const fromStatus = stateRows[0]?.lead_status as LeadStatus | null;
        if (!fromStatus) return errorResponse("Lead not found", 404);

        const t = canTransition(fromStatus, "Transferred_to_ASM", {
            actorRole: user.role,
        });
        if (!t.ok) return errorResponse(t.reason, 400);

        await db.transaction(async (tx) => {
            await tx.execute(sql`
                UPDATE dealer_leads
                SET pre_transfer_status = lead_status,
                    current_owner_id = ${body.asm_id},
                    asm_id = ${body.asm_id},
                    assigned_at = NOW(),
                    updated_at = NOW()
                WHERE id = ${id}
            `);
            await tx.insert(leadVisits).values({
                dealer_lead_id: id,
                asm_id: body.asm_id,
                scheduled_date: body.suggested_visit_date ?? null,
                visit_status: body.suggested_visit_date ? "scheduled" : "pending_scheduling",
            });
        });

        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "asm_transfer",
            performedBy: user.id,
            remarks: `Reason: ${body.reason}; Visit: ${body.visit_type}${
                body.suggested_visit_date ? `; Date: ${body.suggested_visit_date}` : ""
            }${body.dealer_preferred_time ? ` (${body.dealer_preferred_time})` : ""}\n\n${body.handoff_notes}${
                body.pending_items?.length
                    ? `\n\nPending: ${body.pending_items.join(", ")}`
                    : ""
            }${body.out_of_territory_reason ? `\n\nOut-of-territory: ${body.out_of_territory_reason}` : ""}`,
            statusChange: {
                from: fromStatus,
                to: "Transferred_to_ASM",
            },
        });

        return successResponse({ ok: true });
    },
);
