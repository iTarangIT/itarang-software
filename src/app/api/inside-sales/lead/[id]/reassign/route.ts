// POST /api/inside-sales/lead/[id]/reassign
// BRD §0.3 Path C — owner-initiated reassignment with mandatory reason
// (≥ 20 chars). Follow-up carries forward unchanged. The write lives in
// lib/leads/reassign.ts, shared with the WhatsApp Assistant.

//
// ID 155: GET returns whether the viewer may move this lead as the owner's
// manager, and to whom (themself + their direct reports), for the picker.
//
// ID 221 (decided 3 Nov, Kartik): the OWNER also picks by name, and only from
// their own active direct reports (no user-id box); nobody under them = no
// Reassign (an ISR still has Transfer to ASM). "Notify admin" is gone: the old
// owner's manager gets a bell with the reason. Admin, Sales Head and CEO keep
// the Leads-list reassign to anyone.

import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { getTeamMemberIds } from "@/lib/users/team";
import { checkOwnerReassign, checkReassignReason, checkTeamReassign, ownerScopeIds } from "@/lib/users/teamRules";
import { activeReportTargets, teamTargetsFor } from "@/lib/users/teamTargets";
import { assertOwner } from "@/lib/leads/ownership";
import { REASSIGN_REASON_MIN, ReassignError, reassignLead } from "@/lib/leads/reassign";
import { notifyLeadsReassigned, notifyOwnersManager } from "@/lib/leads/newOwnerNotice";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

const BodySchema = z.object({
    target_user_id: z.string().min(1),
    reason: z.string().min(REASSIGN_REASON_MIN).max(5000),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());
        // ID 155: the reason is mandatory on every path (owner and manager) —
        // checked trimmed, so whitespace padding does not satisfy it.
        const reasonCheck = checkReassignReason(body.reason, REASSIGN_REASON_MIN);
        if (!reasonCheck.ok) return errorResponse(reasonCheck.message, 400);
        body.reason = reasonCheck.reason;

        // ID 155: the owner reassigns as before; a MANAGER (anyone with direct
        // reports) may also move a direct report's lead to themself or another
        // direct report. Same reason rule, same ownership_transfer touchpoint
        // and new-owner bell as every owner change (ID 83).
        const [lead] = await db
            .select({ current_owner_id: dealerLeads.current_owner_id })
            .from(dealerLeads)
            .where(eq(dealerLeads.id, id))
            .limit(1);
        const isOwner = !!lead && lead.current_owner_id === user.id;
        const teamMemberIds = isOwner ? [] : await getTeamMemberIds(user.id);
        if (isOwner || teamMemberIds.length === 0) await assertOwner(id, user.id);

        let visitsMoved = 0;
        try {
            if (isOwner) {
                // ID 221: only to someone in the owner's own team.
                const reports = await activeReportTargets(user.id);
                const ownerCheck = checkOwnerReassign({ targetUserId: body.target_user_id, reportIds: reports.map((r) => r.id) });
                if (!ownerCheck.ok) return errorResponse(ownerCheck.message, 403);
                ({ visitsMoved } = await reassignLead({
                    leadId: id,
                    actorId: user.id,
                    targetUserId: body.target_user_id,
                    reason: body.reason,
                }));
            } else {
                const refusal = await db.transaction(async (tx) => {
                    // Re-read the owner under a row lock, so the team check and
                    // the move see the same owner.
                    const locked = (await tx.execute(sql`
                        SELECT current_owner_id::text AS current_owner_id FROM dealer_leads WHERE id = ${id} FOR UPDATE
                    `)) as unknown as Array<{ current_owner_id: string | null }>;
                    if (!locked[0]) return { message: "Lead not found", status: 404 as const };
                    const check = checkTeamReassign({
                        actorId: user.id,
                        currentOwnerId: locked[0].current_owner_id,
                        targetUserId: body.target_user_id,
                        teamMemberIds,
                    });
                    if (!check.ok) return { message: check.message, status: (check.reason === "not_manager" ? 403 : 400) as 400 | 403 };
                    ({ visitsMoved } = await reassignLead(
                        {
                            leadId: id,
                            actorId: user.id,
                            targetUserId: body.target_user_id,
                            reason: body.reason,
                            fromOwnerId: locked[0].current_owner_id ?? undefined,
                        },
                        { tx },
                    ));
                    return null;
                });
                if (refusal) return errorResponse(refusal.message, refusal.status);
            }
        } catch (err) {
            if (err instanceof ReassignError) return errorResponse(err.message, err.status);
            throw err;
        }
        // The new owner's bell opens the lead on their page. ID 179: a manager's
        // move also tells the rep it was taken from.
        await notifyLeadsReassigned({
            leadIds: [id],
            targetUserId: body.target_user_id,
            actorId: user.id,
            reason: body.reason,
            fromOwners: { [id]: lead?.current_owner_id ?? null },
        });
        // ID 221: the old owner's manager hears of it, with the reason.
        await notifyOwnersManager({
            leadId: id,
            fromOwnerId: lead?.current_owner_id ?? null,
            toUserId: body.target_user_id,
            actorId: user.id,
            reason: body.reason,
        });

        return successResponse({ ok: true, visits_moved: visitsMoved });
    },
);

// Who the viewer may hand this lead to, by name.
//   - The owner (ID 221): their active direct reports; can_owner_reassign is
//     false when they have none (the Reassign button is then hidden).
//   - The owner's manager (ID 155): themself + their team, minus the owner.
export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const [lead] = await db
            .select({ current_owner_id: dealerLeads.current_owner_id })
            .from(dealerLeads)
            .where(eq(dealerLeads.id, id))
            .limit(1);
        if (!lead) return errorResponse("Lead not found", 404);
        if (lead.current_owner_id === user.id) {
            const targets = await activeReportTargets(user.id);
            return successResponse({ can_team_reassign: false, can_owner_reassign: targets.length > 0, targets });
        }
        const teamMemberIds = await getTeamMemberIds(user.id);
        const managesOwner = !!lead.current_owner_id && teamMemberIds.includes(lead.current_owner_id);
        if (!managesOwner) return successResponse({ can_team_reassign: false, can_owner_reassign: false, targets: [] });
        const ids = ownerScopeIds(user.id, teamMemberIds).filter((u) => u !== lead.current_owner_id);
        const targets = await teamTargetsFor(ids, user.id);
        return successResponse({ can_team_reassign: true, can_owner_reassign: false, targets });
    },
);
