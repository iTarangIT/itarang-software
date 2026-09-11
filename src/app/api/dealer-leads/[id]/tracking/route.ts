/**
 * GET /api/dealer-leads/[id]/tracking            → JSON  { success, data: LeadTracking }
 * GET /api/dealer-leads/[id]/tracking?format=csv → the same as one CSV download
 *
 * The "Lead tracking" section (E-295): where the lead has travelled, how long
 * each person held it, what everyone did while holding it, and where it stands
 * now. Read-only; exporting the journey is not an event in the journey.
 *
 * Access — two tiers of LEAD_TRACKING_ROLES (src/lib/leads/access.ts):
 *   admin / ceo / sales_head      any lead.
 *   inside_sales_rep / asm        only leads they have handled
 *                                 (canViewLeadTracking — current owner, ASM,
 *                                 originator, or recipient of a recorded hop).
 * Lives under /api/dealer-leads, not /api/leads: that prefix is the OTHER lead
 * family (the `leads` table, customers of a dealer).
 */

import { withErrorHandler, errorResponse, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
    LEAD_TRACKING_OWN_ONLY_ROLES,
    LEAD_TRACKING_ROLES,
} from "@/lib/leads/access";
import { buildLeadTracking, canViewLeadTracking } from "@/lib/leads/tracking";
import { trackingCsvResponse } from "@/lib/leads/trackingCsv";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...LEAD_TRACKING_ROLES]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        if ((LEAD_TRACKING_OWN_ONLY_ROLES as readonly string[]).includes(user.role)) {
            const ok = await canViewLeadTracking(user.id, id);
            if (!ok) {
                return errorResponse(
                    "You can only track leads you have handled.",
                    403,
                );
            }
        }

        const tracking = (await buildLeadTracking([id])).get(id);
        if (!tracking) return errorResponse("Lead not found", 404);

        const format = new URL(req.url).searchParams.get("format");
        if (format === "csv") {
            const safe = (tracking.lead.dealer_name || tracking.lead.phone || id)
                .replace(/[^a-zA-Z0-9_-]/g, "_")
                .slice(0, 60);
            return trackingCsvResponse([tracking], `lead-tracking-${safe}`);
        }
        return successResponse(tracking);
    },
);
