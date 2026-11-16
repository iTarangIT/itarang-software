// ID 235: Reassign's "Also move to <new owner>'s NeoDove campaign".
//
// GET  ?to=<userId>        → what would move: the lead's current campaign and
//                            the new owner's (E-237 crm_owner_user_id) — and
//                            whether to offer the move at all.
// POST { to_user_id }      → after the reassign: push the lead into the new
//                            owner's campaign (force: the lead is being worked)
//                            and note it on the timeline. NeoDove has no remove
//                            API, so the answer tells the person to take it out
//                            of the old campaign in NeoDove by hand.
//
// POST only follows a reassignment: the lead must already belong to to_user_id.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { leadNeodoveCampaign, movePreview, ownerNeodoveCampaign } from "@/lib/neodove/leadCampaign";
import { pushOneLead } from "@/lib/neodove/pushOne";
import { writeTouchpoint } from "@/lib/touchpoints/write";

// Everyone who can reassign a lead (the two Reassign windows).
const ROLES = ["inside_sales_rep", "asm", "admin", "partner", "sales_head", "ceo"];

export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(ROLES);
    const { id } = await ctx.params;
    const to = new URL(req.url).searchParams.get("to");
    if (!id || !to) return errorResponse("Lead id and ?to= are required", 400);
    const [current, target] = await Promise.all([leadNeodoveCampaign(id), ownerNeodoveCampaign(to)]);
    return successResponse(movePreview(current, target));
});

const Body = z.object({ to_user_id: z.string().min(1) });

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(ROLES);
    const { id } = await ctx.params;
    const { to_user_id } = Body.parse(await req.json());

    const owner = (await db.execute<{ current_owner_id: string | null }>(sql`
        SELECT current_owner_id FROM dealer_leads WHERE id = ${id} LIMIT 1
    `)) as unknown as { current_owner_id: string | null }[];
    if (!owner[0]) return errorResponse("Lead not found", 404);
    if (owner[0].current_owner_id !== to_user_id) {
        return errorResponse("Reassign the lead first; the NeoDove campaign moves with the owner.", 409);
    }

    const [current, target] = await Promise.all([leadNeodoveCampaign(id), ownerNeodoveCampaign(to_user_id)]);
    const preview = movePreview(current, target);
    if (!preview.offer || !target || !current) {
        return errorResponse("Nothing to move: the lead is not in a NeoDove campaign, or the new owner has none of their own.", 409);
    }

    const pushed = await pushOneLead({ leadId: id, campaignId: target.campaign_id, force: true });
    if (!pushed.ok) return errorResponse(`NeoDove did not take the lead: ${pushed.message}`, pushed.status);

    const oldName = current.neodove_name ?? current.name;
    await writeTouchpoint({
        dealerLeadId: id,
        touchpointType: "status_change_note",
        performedBy: user.id,
        remarks: `NeoDove campaign moved with the reassignment: now in "${target.name}" (was "${current.name}"). Remove it from "${oldName}" in NeoDove by hand.`,
    });

    return successResponse({
        moved_to: target.name,
        remove_from: oldName,
        message: `Moved to ${target.name}. Now remove the lead from "${oldName}" in NeoDove by hand — NeoDove cannot be told to do it.`,
    });
});
