// POST /api/asm/lead/[id]/visit
// BRD §0.8 — ASM logs a visit. The write itself (lead_visits row + parallel
// `visit` touchpoint, one transaction) lives in recordVisit() so the WhatsApp
// Assistant logs a visit exactly the same way.
//
// next_action is stored on lead_visits for audit; the client reads it from
// the response to chain into Mark Converted / Mark Lost / Escalate. Status
// transitions are NOT performed here — they go through their dedicated
// routes so the canTransition validator stays the single source of truth.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { recordVisit } from "@/lib/asm/recordVisit";
import { assertOwner } from "@/lib/leads/ownership";
import {
    VISIT_NEXT_ACTION,
    VISIT_OUTCOME,
    VISIT_STATUS,
} from "@/lib/asm/types";

const MUTATE_ROLES = ["asm", "admin"];

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

        const { visitId } = await recordVisit({ ...body, leadId: id, asmId: user.id });

        return successResponse({
            visit_id: visitId,
            next_action: body.next_action,
        });
    },
);
