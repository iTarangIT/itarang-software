// POST /api/inside-sales/lead/[id]/reassign
// BRD §0.3 Path C — owner-initiated reassignment with mandatory reason
// (≥ 20 chars). Follow-up carries forward unchanged. The write lives in
// lib/leads/reassign.ts, shared with the WhatsApp Assistant.

//
// ID 155: GET returns whether the viewer may move this lead as the owner's
// manager, and to whom (themself + their direct reports), for the picker.
//
// ID 221 (Kartik, 3 Nov): the OWNER too hands a lead only to the team under
// them — their active direct reports, picked by name. No user-id box; the
// server refuses anyone else. Nobody under the owner = no Reassign (an ISR
// still sends a lead to an ASM with Transfer to ASM). 'Notify admin' is gone;
// the new owner and the old owner's manager get a bell.

import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { dealerLeads, users } from "@/lib/db/schema";
import { getManagerOf, getReassignPickList, getTeamMemberIds } from "@/lib/users/team";
import { checkReassignReason, checkTeamReassign, ownerScopeIds } from "@/lib/users/teamRules";
import { assertOwner } from "@/lib/leads/ownership";
import { REASSIGN_REASON_MIN, ReassignError, reassignLead } from "@/lib/leads/reassign";
import { notifyLeadsReassigned, notifyOwnerManagerOfMove } from "@/lib/leads/newOwnerNotice";

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

        try {
            if (isOwner) {
                // ID 221: only to someone in the owner's own team.
                const mine = await getTeamMemberIds(user.id);
                if (!mine.includes(body.target_user_id)) {
                    return errorResponse(
                        "You can hand a lead only to someone in your team. Ask your manager to move it to anyone else.",
                        403,
                    );
                }
                await reassignLead({
                    leadId: id,
                    actorId: user.id,
                    targetUserId: body.target_user_id,
                    reason: body.reason,
                });
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
                    await reassignLead(
                        {
                            leadId: id,
                            actorId: user.id,
                            targetUserId: body.target_user_id,
                            reason: body.reason,
                            fromOwnerId: locked[0].current_owner_id ?? undefined,
                        },
                        { tx },
                    );
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
        // ID 221: the old owner's manager hears about it too.
        const fromOwnerId = lead?.current_owner_id ?? null;
        await notifyOwnerManagerOfMove({
            leadId: id,
            fromOwnerId,
            managerId: await getManagerOf(fromOwnerId),
            toUserId: body.target_user_id,
            actorId: user.id,
            reason: body.reason,
        });

        return successResponse({ ok: true });
    },
);

// ID 155: who the viewer may hand this lead to as the owner's manager.
// ID 221: for the owner themself, their active direct reports
// (can_owner_reassign); empty = no Reassign button.
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
            const targets = (await getReassignPickList(user.id)).map((t) => ({ ...t, is_self: false }));
            return successResponse({ can_team_reassign: false, can_owner_reassign: targets.length > 0, targets });
        }
        const teamMemberIds = await getTeamMemberIds(user.id);
        const managesOwner = !!lead.current_owner_id && teamMemberIds.includes(lead.current_owner_id);
        if (!managesOwner) return successResponse({ can_team_reassign: false, can_owner_reassign: false, targets: [] });
        const ids = ownerScopeIds(user.id, teamMemberIds).filter((u) => u !== lead.current_owner_id);
        const rows = ids.length
            ? await db
                  .select({ id: users.id, name: users.name, role: users.role, is_active: users.is_active })
                  .from(users)
                  .where(inArray(users.id, ids))
            : [];
        const territory = new Map((await getReassignPickList(user.id)).map((t) => [t.id, t.territory]));
        const targets = rows
            .filter((r) => r.is_active !== false)
            .map((r) => ({
                id: r.id,
                name: r.name,
                role: r.role,
                territory: territory.get(r.id) ?? null,
                is_self: r.id === user.id,
            }))
            .sort((a, b) => Number(b.is_self) - Number(a.is_self) || a.name.localeCompare(b.name));
        return successResponse({ can_team_reassign: true, can_owner_reassign: false, targets });
    },
);
