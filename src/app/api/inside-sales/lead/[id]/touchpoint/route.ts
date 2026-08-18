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
import {
    callStatusForDisposition,
    classifyDisposition,
    CONNECT_STATUS,
    DISPOSITION_BUCKETS,
    resolveBucket,
    type ClassifiedDisposition,
} from "@/lib/leads/dispositions";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

const BodySchema = z.object({
    touchpoint_type: z.enum(TOUCHPOINT_TYPE),
    performed_at: z.string().datetime().optional(),
    // Retained for any caller still sending it. The disposition wins when both
    // are present.
    call_status: z.enum(CALL_STATUS).nullable().optional(),
    // The CC team's L1/L2/L3. `bucket` is sent explicitly so a rep who picked
    // "Commercials Explained" under Hot gets Hot — see resolveBucket.
    disposition: z
        .object({
            connect_status: z.enum(CONNECT_STATUS),
            bucket: z.enum(DISPOSITION_BUCKETS).nullable().optional(),
            label: z.string().trim().min(1).max(120),
        })
        .nullable()
        .optional(),
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
                (SELECT COUNT(*)::text FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.is_engaged = true) AS engaged_count,
                (SELECT final_price::text FROM dealer_lead_commercials c WHERE c.dealer_lead_id = dl.id AND c.is_current = true LIMIT 1) AS final_price,
                EXISTS (SELECT 1 FROM dealer_lead_commercials c WHERE c.dealer_lead_id = dl.id) AS commercials_exists
            FROM dealer_leads dl WHERE dl.id = ${id} LIMIT 1
        `);
        const state = rows[0];
        if (!state) return errorResponse("Lead not found", 404);
        const fromStatus = (state.lead_status as LeadStatus | null) ?? null;

        // Classify the disposition BEFORE isEngaged, which depends on the
        // derived call status, which depends on this.
        //
        // A manual pick MUST be in the sheet — the OPPOSITE of the inbound rule.
        // mapper.ts must never reject, because a refused NeoDove delivery cannot
        // be re-fetched; here the input is a closed dropdown, so a value outside
        // the sheet can only come from a hand-crafted request, and letting one
        // through would poison the /leads disposition facet, which reads DISTINCT
        // from the data rather than from the sheet.
        let classified: ClassifiedDisposition | null = null;
        if (body.disposition) {
            const hit = classifyDisposition(body.disposition.label, {
                callConnected: body.disposition.connect_status === "connected",
            });
            if (!hit?.isKnown || hit.connectStatus !== body.disposition.connect_status) {
                return errorResponse(
                    "Unknown disposition for the selected call outcome.",
                    400,
                );
            }
            classified = {
                ...hit,
                bucket: resolveBucket(hit.label, hit.bucket, {
                    stage: body.disposition.bucket ?? null,
                }),
            };
        }

        // One vocabulary, derived server-side: the client can be stale, and the
        // rule belongs next to the sheet. call_status keeps being written with
        // exactly the same five values as before, because five things key off it
        // — shouldAutoEngage → is_engaged → canTransition's engaged-count gate,
        // two report figures and two dashboard timings — and 2,445 historical
        // rows already have it.
        const derivedCallStatus =
            callStatusForDisposition(classified) ?? body.call_status ?? null;

        // Auto-engage when applicable (BRD §0.1 Glossary).
        const isEngaged =
            body.is_engaged ??
            shouldAutoEngage(body.touchpoint_type, {
                callStatus: derivedCallStatus,
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

        let result;
        try {
            result = await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: body.touchpoint_type,
                performedBy: user.id,
                performedAt: body.performed_at
                    ? new Date(body.performed_at)
                    : undefined,
                callStatus: derivedCallStatus,
                callDurationSec: body.call_duration_sec ?? null,
                disposition: classified
                    ? {
                          label: classified.label,
                          bucket: classified.bucket,
                          connectStatus: classified.connectStatus!,
                      }
                    : null,
                dispositionSource: "inside_sales",
                isEngaged,
                remarks: body.remarks ?? null,
                attachments: body.attachments ?? null,
                nextAction: body.next_action ?? null,
                nextActionAt: body.next_action_at
                    ? new Date(body.next_action_at)
                    : null,
                statusChange,
            });
        } catch (err) {
            // 42703 = undefined_column. Only reachable when a disposition was
            // sent AND this database has not applied E-236. A legible 503 beats
            // a 500 the rep cannot act on.
            if ((err as { code?: string })?.code === "42703" && body.disposition) {
                return errorResponse(
                    "Call dispositions are not available on this database yet. Save without one, or ask an admin to apply E-236.",
                    503,
                );
            }
            throw err;
        }

        // Caller wants to set / clear next_follow_up_at (BRD §0.5 form field).
        if (body.follow_up_at !== undefined) {
            await db.execute(sql`
                UPDATE dealer_leads
                SET next_follow_up_at = ${body.follow_up_at ?? null},
                    updated_at = NOW()
                WHERE id = ${id}
            `);
        }

        return successResponse(result);
    },
);
