// POST /api/asm/lead/[id]/visit
// BRD §0.8 — ASM logs a visit. Writes lead_visits + a parallel
// lead_touchpoints row (type='visit') in one transaction so the unified
// history pane shows visits inline. is_engaged auto-set when outcome ∈
// {productive, commercials_progressed} per BRD §0.1 Glossary.
//
// next_action is stored on lead_visits for audit; the client reads it from
// the response to chain into Mark Converted / Mark Lost / Escalate. Status
// transitions are NOT performed here — they go through their dedicated
// routes so the canTransition validator stays the single source of truth.

import { z } from "zod";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { assertOwner } from "@/lib/leads/ownership";
import {
    ENGAGED_OUTCOMES,
    VISIT_NEXT_ACTION,
    VISIT_OUTCOME,
    VISIT_STATUS,
} from "@/lib/asm/types";

const MUTATE_ROLES = ["asm", "admin"];

const BodySchema = z
    .object({
        visit_status: z.enum(VISIT_STATUS),
        actual_visit_date: z.string().date().nullable().optional(),
        scheduled_date: z.string().date().nullable().optional(),
        visit_outcome: z.enum(VISIT_OUTCOME).nullable().optional(),
        visit_remarks: z.string().min(1).max(5000),
        photos: z.array(z.string().url()).max(10).optional(),
        gps_check_in_lat: z.number().min(-90).max(90).nullable().optional(),
        gps_check_in_lng: z.number().min(-180).max(180).nullable().optional(),
        next_action: z.enum(VISIT_NEXT_ACTION),
        next_visit_date: z.string().date().nullable().optional(),
    })
    .refine((b) => b.visit_status !== "visited" || !!b.visit_outcome, {
        message: "visit_outcome required when visit_status='visited'",
        path: ["visit_outcome"],
    })
    .refine((b) => b.next_action !== "next_visit" || !!b.next_visit_date, {
        message: "next_visit_date required when next_action='next_visit'",
        path: ["next_visit_date"],
    });

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const isEngaged = body.visit_outcome
            ? ENGAGED_OUTCOMES.includes(body.visit_outcome)
            : false;

        const visitId = await db.transaction(async (tx) => {
            const inserted = await tx
                .insert(leadVisits)
                .values({
                    dealer_lead_id: id,
                    asm_id: user.id,
                    scheduled_date: body.scheduled_date ?? null,
                    actual_visit_date:
                        body.actual_visit_date ??
                        (body.visit_status === "visited" ? new Date().toISOString().slice(0, 10) : null),
                    visit_status: body.visit_status,
                    visit_outcome: body.visit_outcome ?? null,
                    visit_remarks: body.visit_remarks,
                    photos: (body.photos ?? []) as never,
                    gps_check_in_lat:
                        body.gps_check_in_lat != null ? String(body.gps_check_in_lat) : null,
                    gps_check_in_lng:
                        body.gps_check_in_lng != null ? String(body.gps_check_in_lng) : null,
                    next_action: body.next_action,
                    next_visit_date: body.next_visit_date ?? null,
                })
                .returning({ visit_id: leadVisits.visit_id });
            return inserted[0]?.visit_id ?? null;
        });

        // Parallel touchpoint row keeps the unified history pane current.
        await writeTouchpoint({
            dealerLeadId: id,
            touchpointType: "visit",
            performedBy: user.id,
            isEngaged,
            remarks:
                `${body.visit_status}` +
                (body.visit_outcome ? ` · ${body.visit_outcome}` : "") +
                `\n\n${body.visit_remarks}` +
                (body.next_action === "next_visit" && body.next_visit_date
                    ? `\n\nNext visit: ${body.next_visit_date}`
                    : ""),
            attachments: body.photos?.map((url) => ({ url, type: "photo" })) ?? null,
            nextAction:
                body.next_action === "next_visit"
                    ? "follow_up"
                    : body.next_action === "convert"
                        ? "mark_converted"
                        : body.next_action === "lost"
                            ? "mark_lost"
                            : null,
            nextActionAt: body.next_visit_date ? new Date(body.next_visit_date) : null,
        });

        return successResponse({
            visit_id: visitId,
            next_action: body.next_action,
        });
    },
);
