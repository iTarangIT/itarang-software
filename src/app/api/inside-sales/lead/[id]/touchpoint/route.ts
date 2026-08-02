// POST /api/inside-sales/lead/[id]/touchpoint
// Log a touchpoint, optionally with a status change + optional next_follow_up_at.
// BRD §0.5 — the primary action on Lead Detail.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { TOUCHPOINT_TYPE, CALL_STATUS, NEXT_ACTION, shouldAutoEngage } from "@/lib/lifecycle/touchpointTypes";
import {
    canTransition,
    LEAD_STATUS,
    type LeadStatus,
} from "@/lib/lifecycle/transitions";
import { assertOwner } from "@/lib/leads/ownership";

import { dealerLeads, leadTouchpoints, dealerLeadCommercials } from "@/lib/db/schema";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

const BodySchema = z.object({
    touchpoint_type: z.enum(TOUCHPOINT_TYPE),
    performed_at: z.string().datetime().optional(),
    call_status: z.enum(CALL_STATUS).nullable().optional(),
    call_duration_sec: z.number().int().min(0).max(36000).nullable().optional(),
    is_engaged: z.boolean().optional(),
    remarks: z.string().max(5000).optional(),
    attachments: z.array(z.unknown()).max(20).optional(),
    next_action: z.enum(NEXT_ACTION).nullable().optional(),
    next_action_at: z.string().datetime().nullable().optional(),
    status_change: z
        .object({
            to: z.enum(LEAD_STATUS),
            reason_notes: z.string().max(2000).nullable().optional(),
        })
        .optional(),
    follow_up_at: z.string().datetime().nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        // Read current state for transition validation.
        const rows = await db.execute<{
            lead_status: string | null;
            engaged_count: string;
            final_price: string | null;
            commercials_exists: boolean;
        }>(sql`
            SELECT
                dl.lead_status,
                (SELECT COUNT(*)::text FROM ${leadTouchpoints} t WHERE t.dealer_lead_id = dl.id AND t.is_engaged = true) AS engaged_count,
                (SELECT final_price::text FROM ${dealerLeadCommercials} c WHERE c.dealer_lead_id = dl.id AND c.is_current = true LIMIT 1) AS final_price,
                EXISTS (SELECT 1 FROM ${dealerLeadCommercials} c WHERE c.dealer_lead_id = dl.id) AS commercials_exists
            FROM ${dealerLeads} dl WHERE dl.id = ${id} LIMIT 1
        `);
        const state = rows[0];
        if (!state) return errorResponse("Lead not found", 404);
        const fromStatus = (state.lead_status as LeadStatus | null) ?? null;

        // Auto-engage when applicable (BRD §0.1 Glossary).
        const isEngaged =
            body.is_engaged ??
            shouldAutoEngage(body.touchpoint_type, {
                callStatus: body.call_status ?? null,
                visitOutcome: null,
            });

        // If caller requested a status change, validate it BEFORE writing.
        let statusChange: Parameters<typeof writeTouchpoint>[0]["statusChange"];
        if (body.status_change) {
            if (!fromStatus) {
                return errorResponse(
                    "Cannot change status — lead has no current status.",
                    400,
                );
            }
            // Engaged-count delta if this very touchpoint will be engaged.
            const engagedAfter = Number(state.engaged_count ?? 0) + (isEngaged ? 1 : 0);
            const t = canTransition(fromStatus, body.status_change.to, {
                engagedTouchpointCount: engagedAfter,
                finalPrice: state.final_price === null ? null : Number(state.final_price),
                hasCommercialsRow: Boolean(state.commercials_exists),
                actorRole: user.role,
            });
            if (!t.ok) {
                return errorResponse(t.reason, t.severity === "soft" ? 422 : 400);
            }
            statusChange = {
                from: fromStatus,
                to: body.status_change.to,
                reasonNotes: body.status_change.reason_notes ?? null,
                closingRole:
                    body.status_change.to === "Converted" || body.status_change.to === "Lost"
                        ? "is_phone"
                        : undefined,
            };
        }

        const result = await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: body.touchpoint_type,
            performedBy: user.id,
            performedAt: body.performed_at ? new Date(body.performed_at) : undefined,
            callStatus: body.call_status ?? null,
            callDurationSec: body.call_duration_sec ?? null,
            isEngaged,
            remarks: body.remarks ?? null,
            attachments: body.attachments ?? null,
            nextAction: body.next_action ?? null,
            nextActionAt: body.next_action_at ? new Date(body.next_action_at) : null,
            statusChange,
        });

        // Caller wants to set / clear next_follow_up_at (BRD §0.5 form field).
        if (body.follow_up_at !== undefined) {
            await db.execute(sql`
                UPDATE ${dealerLeads}
                SET next_follow_up_at = ${body.follow_up_at ?? null},
                    updated_at = NOW()
                WHERE id = ${id}
            `);
        }

        return successResponse(result);
    },
);
