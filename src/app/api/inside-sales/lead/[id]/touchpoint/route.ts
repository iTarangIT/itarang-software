// POST /api/inside-sales/lead/[id]/touchpoint
// Log a touchpoint, optionally with a status change + optional next_follow_up_at.
// BRD §0.5 — the primary action on Lead Detail. The write (one transaction:
// touchpoint, status change, follow-up) lives in logLeadTouchpoint(), shared
// with the WhatsApp Assistant.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import {
    LeadNotFoundError,
    logLeadTouchpoint,
    TouchpointBodySchema,
    UnknownDispositionError,
} from "@/lib/inside-sales/logTouchpoint";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = TouchpointBodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        try {
            const result = await logLeadTouchpoint({ leadId: id, actorId: user.id, body });
            return successResponse(result);
        } catch (err) {
            if (err instanceof LeadNotFoundError) return errorResponse("Lead not found", 404);
            if (err instanceof UnknownDispositionError) return errorResponse(err.message, 400);
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
    },
);
