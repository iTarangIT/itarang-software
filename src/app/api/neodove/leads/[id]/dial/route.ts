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
//
// WHO MAY ASK (tracker ID 83). The NeoDove admin roles, for any lead — and the
// lead's OWNER (a rep or an ASM), for their own lead only. The owner's request
// is what "called on your behalf" hangs on: the call the agent then makes is
// marked, and the owner notified, only when the dial request was written by the
// owner (ownerFromCall.ts). With the route admin-only that could never happen.
// An owner's request never reassigns the lead, and needs no "someone is already
// working this" override — they are the someone.

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
import { assertOwner, ForbiddenLeadAccessError } from "@/lib/leads/ownership";
import {
    ASSIGN_ON_PUSH,
    assignAfterPush,
    resolveNeodoveAssignee,
} from "@/lib/neodove/assignAfterPush";
import { writeTouchpoint } from "@/lib/touchpoints/write";

export const runtime = "nodejs";

/** Roles that may ask for a call on a lead THEY OWN (ID 83). */
const OWNER_DIAL_ROLES = ["inside_sales_rep", "asm"];

const bodySchema = z.object({
    // Same override as the push route, and for the same reason: handing a lead
    // an ASM is mid-negotiation on to the calling team is legitimate sometimes,
    // but never silently.
    force: z.boolean().optional(),
    // Omitted = use the priority campaign's default CRM owner, null = don't
    // assign, a string = override for this dial (E-237).
    assignToUserId: z.string().trim().min(1).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...NEODOVE_ADMIN_ROLES, ...OWNER_DIAL_ROLES]);
        const { id } = await context.params;

        // A rep / ASM asks only for a lead they own. Checked before anything is
        // pushed: a push spends NeoDove quota and cannot be undone.
        const ownerRequest = !NEODOVE_ADMIN_ROLES.includes(user.role);
        if (ownerRequest) {
            try {
                await assertOwner(id, user.id);
            } catch (err) {
                if (err instanceof ForbiddenLeadAccessError) {
                    return errorResponse("Only the lead's owner can ask for it to be called now.", 403);
                }
                throw err;
            }
        }

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

        const assignee = await resolveNeodoveAssignee({
            campaignId: campaign.id,
            // The owner keeps their lead: null = "do not assign", whatever the
            // campaign's default owner is and whatever the body says.
            assignToUserId: ownerRequest ? null : parsed.data.assignToUserId,
        });
        if (!assignee.ok) {
            return errorResponse(assignee.message, assignee.status);
        }

        const result = await pushOneLead({
            leadId: id,
            campaignId: campaign.id,
            // The exclusion rule refuses a lead "someone is already working".
            // For the owner's own request that someone is the owner.
            force: ownerRequest ? true : parsed.data.force,
        });

        const destination =
            campaign.neodove_campaign_name ?? campaign.name;

        // Assign on any ATTEMPTED push — `ok`, or a 502 that left here and
        // failed at NeoDove's end. Never on the pre-push refusals (404 / 409 /
        // 400), which sent nothing.
        let assigned = false;
        if (ASSIGN_ON_PUSH && assignee.target && (result.ok || result.status === 502)) {
            assigned = await assignAfterPush({
                leadId: id,
                campaignId: campaign.id,
                target: assignee.target,
                actorId: user.id,
                actorRole: user.role,
                campaignLabel: destination,
            });
        }

        if (!result.ok) return errorResponse(result.message, result.status);

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
                remarks: ownerRequest
                    ? `Call now requested by the lead's owner — pushed to NeoDove campaign "${destination}". The call that follows is made on the owner's behalf.`
                    : `Priority dial requested — pushed to NeoDove campaign "${destination}" for immediate calling.${parsed.data.force ? " Exclusion rule overridden: someone here is already working this lead." : ""}`,
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
            assigned,
            assignedTo: assigned && assignee.target ? assignee.target.name : null,
        });
    },
);
