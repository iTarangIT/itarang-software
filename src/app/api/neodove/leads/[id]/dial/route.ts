// POST /api/neodove/leads/[id]/dial — "Call this lead now" (E-226).
//
// WHAT THIS IS NOT. It does not dial. NeoDove exposes no dial API, no call
// control and no agent API (docs/neodove-contract.md) — nothing the CRM sends
// can make a phone ring. Any endpoint here claiming otherwise would be lying to
// the operator, and the operator would find out only when the customer said
// nobody called.
//
// WHAT IT ACTUALLY DOES. It pushes this one lead into the campaign marked
// `is_priority_dial`, whose NeoDove-side lead distribution is configured to hand
// arriving leads straight to an agent. The lead therefore surfaces at the top of
// a live queue within seconds rather than in the next bulk batch. That is the
// whole mechanism, and it lives entirely in NeoDove's campaign settings — which
// is why the response says "queued for" and never "calling".
//
// WHY A SEPARATE ROUTE FROM .../push RATHER THAN A FLAG ON IT. Three real
// differences: the destination is not chosen by the caller (there is exactly one
// priority campaign, by unique index), it writes a touchpoint so the request is
// visible on the lead's timeline, and its failure modes are different — "no
// priority campaign is configured" is a setup problem with a specific remedy,
// not a push error.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { getNeodoveConfig } from "@/lib/neodove/config";
import { getPriorityDialCampaign, pushOneLead } from "@/lib/neodove/pushOne";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";
import { writeTouchpoint } from "@/lib/touchpoints/write";

export const runtime = "nodejs";

const bodySchema = z.object({
    // Same override as the push route, and for the same reason: handing a lead
    // an ASM is mid-negotiation on to the calling team is legitimate sometimes,
    // but never silently.
    force: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        if (!getNeodoveConfig().enabled) {
            return errorResponse("NeoDove integration is disabled.", 409);
        }

        const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
            return errorResponse(
                parsed.error.issues.map((i) => i.message).join("; "),
                400,
            );
        }

        const campaign = await getPriorityDialCampaign();
        if (!campaign) {
            return errorResponse(
                "No campaign is set as the priority-dial destination. Open a NeoDove campaign's settings and tick \"Priority dial destination\" — it must be a campaign whose NeoDove-side lead distribution assigns arriving leads to an agent immediately.",
                409,
            );
        }

        const result = await pushOneLead({
            leadId: id,
            campaignId: campaign.id,
            force: parsed.data.force,
        });
        if (!result.ok) return errorResponse(result.message, result.status);

        const destination =
            campaign.neodove_campaign_name ?? campaign.name;

        // The request is logged as a touchpoint, NOT as a call: nobody has
        // spoken to anyone yet. The actual call lands later as a separate
        // `inside_sales_call` touchpoint when NeoDove's webhook reports the
        // disposition — and the two rows next to each other are exactly what
        // shows whether a priority dial was ever worked.
        //
        // Best-effort: the push already happened and cannot be undone, so a
        // timeline write failing must not report the hand-off as failed.
        try {
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "neodove_dial_request",
                performedBy: user.id,
                remarks: `Priority dial requested — pushed to NeoDove campaign "${destination}" for immediate calling.${parsed.data.force ? " Exclusion rule overridden: someone here is already working this lead." : ""}`,
                externalSystem: "neodove",
                syncMethod: "manual",
            });
        } catch (err) {
            console.error("[NeoDove/dial] touchpoint write failed:", err);
        }

        // Distinct from `neodove_sync_status = 'pushed'` on purpose — a lead
        // that was priority-dialled and one that rode a bulk campaign push are
        // not the same thing to whoever is chasing it.
        await db.execute(sql`
            UPDATE dealer_leads
               SET neodove_sync_status = 'priority_dial'
             WHERE id = ${id}
        `);

        return successResponse({
            queued: true,
            campaignId: campaign.id,
            campaignName: destination,
            leadName: result.leadName,
        });
    },
);
