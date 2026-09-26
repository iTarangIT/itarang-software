// POST /api/asm/lead/[id]/visit
// BRD §0.8 — ASM logs a visit. The write itself (lead_visits row + parallel
// `visit` touchpoint, one transaction) lives in recordVisit() so the WhatsApp
// Assistant logs a visit exactly the same way.
//
// next_action is stored on lead_visits for audit; the client reads it from
// the response to chain into Mark Converted / Mark Lost / Escalate. Convert /
// Lost / Transfer still go through their dedicated routes.
//
// Optional status_to (an OPEN progress status) and interest_level: the form
// pre-fills them from the shared auto rule (lib/leads/autoProgress.ts) — the
// same one the WhatsApp Assistant uses — and they are written in the SAME
// transaction as the visit: a status_change_note touchpoint + history, and an
// audited setInterestLevel.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { recordVisit } from "@/lib/asm/recordVisit";
import { assertOwner } from "@/lib/leads/ownership";
import { withLeadActor } from "@/lib/leads/actorContext";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import {
    VISIT_NEXT_ACTION,
    VISIT_OUTCOME,
    VISIT_STATUS,
} from "@/lib/asm/types";

const MUTATE_ROLES = ["asm", "admin"];

/** Statuses a visit may move a lead to. Converted / Lost / Transfer have their own flows. */
const VISIT_STATUS_TARGETS = [
    "Under_Discussion",
    "Commercials_Explained",
    "Awaiting_Customer_Decision",
    "Commercials_Finalised",
] as const;

// PhotoUploader posts to /api/uploads/dealer-documents, which returns an
// absolute Supabase public URL on the Supabase backend but a same-origin
// proxy path ("/api/files/dealer-documents/visit-photos/…") once
// STORAGE_BACKEND=s3. `z.string().url()` rejects the relative form, so every
// visit with a photo attached failed with "Validation failed". Accept either.
const PHOTO_URL_RE = /^(?:https?:\/\/\S+|\/\S+)$/;
const PhotoUrl = z
    .string()
    .min(1)
    .max(2048)
    .regex(PHOTO_URL_RE, {
        message: "photo must be an absolute URL or a same-origin path",
    });

const BodySchema = z
    .object({
        visit_status: z.enum(VISIT_STATUS),
        actual_visit_date: z.string().date().nullable().optional(),
        scheduled_date: z.string().date().nullable().optional(),
        visit_outcome: z.enum(VISIT_OUTCOME).nullable().optional(),
        visit_remarks: z.string().min(1).max(5000),
        photos: z.array(PhotoUrl).max(10).optional(),
        gps_check_in_lat: z.number().min(-90).max(90).nullable().optional(),
        gps_check_in_lng: z.number().min(-180).max(180).nullable().optional(),
        next_action: z.enum(VISIT_NEXT_ACTION),
        next_visit_date: z.string().date().nullable().optional(),
        status_to: z.enum(VISIT_STATUS_TARGETS).nullable().optional(),
        interest_level: z.enum(["hot", "warm", "cold"]).nullable().optional(),
        /** True when interest_level came from the auto rule untouched (audit reason). */
        interest_auto: z.boolean().optional(),
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

        const { status_to, interest_level, interest_auto, ...visit } = body;
        const visited = visit.visit_status === "visited";
        const { visitId } = await withLeadActor(user.id, async (tx) => {
            const recorded = await recordVisit({ ...visit, leadId: id, asmId: user.id }, { tx });
            // A visit that didn't happen can't move the lead.
            if (visited && status_to) {
                await logLeadTouchpoint(
                    {
                        leadId: id,
                        actorId: user.id,
                        body: {
                            touchpoint_type: "status_change_note",
                            remarks: `Status after visit: ${visit.visit_remarks}`,
                            status_change: { to: status_to },
                        },
                    },
                    { tx },
                );
            }
            if (visited && interest_level) {
                await setInterestLevel(
                    {
                        leadId: id,
                        actorId: user.id,
                        level: interest_level,
                        reason: interest_auto ? "Auto: from visit outcome" : "Set with visit",
                    },
                    { tx },
                );
            }
            return recorded;
        });

        return successResponse({
            visit_id: visitId,
            next_action: body.next_action,
        });
    },
);
