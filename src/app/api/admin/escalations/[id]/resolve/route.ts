// POST /api/admin/escalations/[id]/resolve — BRD §0.6 admin resolution.
// Three actions: Reassign / Return to Owner with Guidance / Mark No Action.
// Direct Mark-Lost is deliberately NOT available here (BRD §0.6) — to close a
// lead the admin reassigns first, then the new owner marks it Lost.
// CEO advises (comment/recommend) but never executes — admin only.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";

import { leadEscalations, users, dealerLeads } from "@/lib/db/schema";

const MUTATE_ROLES = ["admin", "sales_head"];

const BodySchema = z
    .object({
        action: z.enum(["reassign", "returned", "no_action"]),
        resolution_notes: z.string().trim().min(10).max(5000),
        target_user_id: z.string().min(1).optional(),
    })
    .refine((b) => b.action !== "reassign" || !!b.target_user_id, {
        message: "Select a user to reassign the lead to.",
        path: ["target_user_id"],
    });

const TOUCHPOINT: Record<
    "reassign" | "returned" | "no_action",
    TouchpointType
> = {
    reassign: "escalation_resolved_reassign",
    returned: "escalation_resolved_returned",
    no_action: "escalation_resolved_no_action",
};

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Escalation id required.", 400);
        const body = BodySchema.parse(await req.json());

        const escRows = await db.execute<{
            dealer_lead_id: string;
            status: string;
        }>(sql`
            SELECT dealer_lead_id, status FROM ${leadEscalations}
            WHERE escalation_id = ${id} LIMIT 1
        `);
        const esc = escRows[0];
        if (!esc) return errorResponse("Escalation not found.", 404);
        if (esc.status !== "pending_review") {
            return errorResponse("This escalation is already resolved.", 409);
        }

        // Reassign — validate the target, then flip ownership (BRD §0.3 Path D).
        if (body.action === "reassign") {
            const targets = await db.execute<{
                id: string;
                is_active: boolean | null;
            }>(sql`
                SELECT id::text AS id, is_active FROM ${users}
                WHERE id::text = ${body.target_user_id} LIMIT 1
            `);
            const target = targets[0];
            if (!target) return errorResponse("Target user not found.", 404);
            if (target.is_active === false) {
                return errorResponse("Target user is inactive.", 400);
            }
            await db.execute(sql`
                UPDATE ${dealerLeads}
                SET current_owner_id = ${body.target_user_id},
                    assigned_at = NOW(),
                    updated_at = NOW()
                WHERE id = ${esc.dealer_lead_id}
            `);
        }

        // Mark the escalation resolved.
        await db.execute(sql`
            UPDATE ${leadEscalations} SET
                status = 'resolved',
                resolved_by = ${user.id},
                resolved_at = NOW(),
                resolution_action = ${body.action},
                resolution_notes = ${body.resolution_notes},
                updated_at = NOW()
            WHERE escalation_id = ${id}
        `);

        // Clear the lead's escalation flag — unless another pending escalation
        // still exists for the same lead.
        await db.execute(sql`
            UPDATE ${dealerLeads} SET
                escalation_status = CASE
                    WHEN EXISTS (
                        SELECT 1 FROM ${leadEscalations}
                        WHERE dealer_lead_id = ${esc.dealer_lead_id}
                          AND status = 'pending_review'
                    ) THEN 'pending_review'
                    ELSE 'resolved'
                END,
                updated_at = NOW()
            WHERE id = ${esc.dealer_lead_id}
        `);

        // Audit touchpoint — keeps the unified history complete.
        await writeTouchpoint({
            dealerLeadId: esc.dealer_lead_id,
            touchpointType: TOUCHPOINT[body.action],
            performedBy: user.id,
            remarks: body.resolution_notes,
        });

        return successResponse({ ok: true, action: body.action });
    },
);
