// POST /api/admin/onboarding-dropouts/[id]/resolve — BRD §0.13 Point B.
// Three admin actions on a Converted lead whose onboarding fell through:
//   keep_converted — counted as won; dropout reason recorded for tracking.
//   flip_to_lost   — lead_status → Lost, lost_reason = 'onboarding_dropout'.
//   re_engage      — runs the reactivation cycle (Converted → Assigned/New).

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
import { ONBOARDING_DROPOUT_REASONS } from "@/lib/admin/types";

const MUTATE_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
    action: z.enum(["keep_converted", "flip_to_lost", "re_engage"]),
    onboarding_dropout_reason: z.enum(ONBOARDING_DROPOUT_REASONS),
    onboarding_dropout_notes: z.string().trim().min(5).max(5000),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required.", 400);
        const body = BodySchema.parse(await req.json());

        const leadRows = await db.execute<{
            lead_status: string | null;
            originator_id: string | null;
        }>(sql`
            SELECT lead_status, originator_id FROM dealer_leads
            WHERE id = ${id} LIMIT 1
        `);
        const lead = leadRows[0];
        if (!lead) return errorResponse("Lead not found.", 404);
        if (lead.lead_status !== "Converted") {
            return errorResponse(
                "Only a Converted lead can be resolved as an onboarding dropout.",
                409,
            );
        }

        if (body.action === "keep_converted") {
            // Stays won; record the dropout reason for tracking only.
            await db.execute(sql`
                UPDATE dealer_leads SET
                    onboarding_dropout_reason = ${body.onboarding_dropout_reason},
                    onboarding_dropout_notes = ${body.onboarding_dropout_notes},
                    updated_at = NOW()
                WHERE id = ${id}
            `);
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "onboarding_dropout_action",
                performedBy: user.id,
                remarks: `Kept Converted — ${body.onboarding_dropout_notes}`,
            });
        } else if (body.action === "flip_to_lost") {
            // Converted → Lost (admin loopback, BRD §0.7).
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "onboarding_dropout_action",
                performedBy: user.id,
                remarks: body.onboarding_dropout_notes,
                statusChange: {
                    from: "Converted",
                    to: "Lost",
                    toLostReason: "onboarding_dropout",
                    closingRole: "admin",
                    reasonNotes: body.onboarding_dropout_notes,
                },
            });
            await db.execute(sql`
                UPDATE dealer_leads SET
                    onboarding_dropout_reason = ${body.onboarding_dropout_reason},
                    onboarding_dropout_notes = ${body.onboarding_dropout_notes},
                    updated_at = NOW()
                WHERE id = ${id}
            `);
        } else {
            // re_engage — reactivation cycle from Converted (BRD §0.9 / §0.13-B).
            let newOwnerId: string | null = null;
            if (lead.originator_id) {
                const owners = await db.execute<{
                    id: string;
                    is_active: boolean | null;
                }>(sql`
                    SELECT id::text AS id, is_active FROM users
                    WHERE id::text = ${lead.originator_id} LIMIT 1
                `);
                if (owners[0] && owners[0].is_active !== false) {
                    newOwnerId = owners[0].id;
                }
            }
            const newStatus = newOwnerId
                ? "Assigned_Not_Contacted"
                : "New_Unassigned";

            await db.transaction(async (tx) => {
                await tx.execute(sql`
                    UPDATE dealer_leads SET
                        lead_status = ${newStatus},
                        closed_at = NULL,
                        closing_owner_id = NULL,
                        closing_role = NULL,
                        current_owner_id = ${newOwnerId},
                        assigned_at = ${newOwnerId ? sql`NOW()` : sql`assigned_at`},
                        onboarding_dropout_reason = ${body.onboarding_dropout_reason},
                        onboarding_dropout_notes = ${body.onboarding_dropout_notes},
                        updated_at = NOW()
                    WHERE id = ${id}
                `);
                await tx.execute(sql`
                    INSERT INTO dealer_lead_status_history
                        (dealer_lead_id, from_status, to_status, changed_by,
                         changed_at, reason_notes)
                    VALUES (${id}, 'Converted', ${newStatus}, ${user.id}, NOW(),
                        ${body.onboarding_dropout_notes})
                `);
                await tx.execute(sql`
                    INSERT INTO lead_touchpoints
                        (dealer_lead_id, touchpoint_type, performed_by,
                         performed_at, remarks, sync_method)
                    VALUES (${id}, 'onboarding_dropout_action', ${user.id}, NOW(),
                        ${`Re-engaged after onboarding dropout — ${body.onboarding_dropout_notes}`},
                        'manual')
                `);
            });
        }

        return successResponse({ ok: true, action: body.action });
    },
);
