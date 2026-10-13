// Owner-initiated reassignment (BRD §0.3 Path C). Extracted from
// POST /api/inside-sales/lead/[id]/reassign so the screen and the WhatsApp
// Assistant reassign exactly the same way. Follow-up carries forward unchanged;
// asm_id is left as it is — except on a hand-back (ID 121): a lead Awaiting
// field visit given to an ISR / partner is refused while the ASM has a visit
// booked, and otherwise returns to its pre-transfer stage with the ASM
// unlinked and the open visits closed (asmHandBack.ts, the same rule as
// assignOwner.ts).
//
// ONE transaction: the owner change and the ownership_transfer touchpoint
// commit together (the route used to run them as two separate statements).
//
// Ownership is the CALLER's job (assertOwner before calling). ID 155: a
// manager may also move a direct report's lead within their team — the route
// checks that (checkTeamReassign) and passes fromOwnerId, so the touchpoint
// records the real previous owner and the manager as the actor.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { statusBeforeTransfer } from "@/lib/leads/assignOwner";
import { handBackRefusal, isHandBack, releaseAsm, releaseNote } from "@/lib/leads/asmHandBack";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REASSIGN_REASON_MIN = 20;

export class ReassignError extends Error {
    constructor(
        readonly code: "self" | "target_not_found" | "target_inactive" | "visit_booked",
        message: string,
        readonly status: 400 | 404 | 409,
    ) {
        super(message);
    }
}

export type ReassignInput = {
    leadId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
    /**
     * ID 155: the owner the lead is taken FROM, when that is not the actor —
     * a manager moving a direct report's lead (the caller checked the team
     * rule, checkTeamReassign). Omitted = the actor owns the lead.
     */
    fromOwnerId?: string;
};

export async function reassignLead(input: ReassignInput, opts?: { tx?: Tx }): Promise<void> {
    const fromOwnerId = input.fromOwnerId ?? input.actorId;
    if (input.targetUserId === fromOwnerId) {
        throw new ReassignError(
            "self",
            input.fromOwnerId ? "The lead is already with that person." : "Cannot reassign to yourself.",
            400,
        );
    }
    const run = async (tx: Tx) => {
        const targets = await tx.execute<{ id: string; is_active: boolean | null; role: string | null; name: string | null }>(sql`
            SELECT id::text AS id, is_active, role, name FROM users WHERE id::text = ${input.targetUserId} LIMIT 1
        `);
        const target = targets[0];
        if (!target) throw new ReassignError("target_not_found", "Target user not found.", 404);
        if (target.is_active === false) {
            throw new ReassignError("target_inactive", "Target user is inactive.", 400);
        }

        const locked = (await tx.execute<{ lead_status: string | null; pre_transfer_status: string | null }>(sql`
            SELECT lead_status, pre_transfer_status FROM dealer_leads WHERE id = ${input.leadId} FOR UPDATE
        `)) as unknown as Array<{ lead_status: string | null; pre_transfer_status: string | null }>;
        const handBack = isHandBack(locked[0]?.lead_status, target.role);
        if (handBack) {
            const refusal = await handBackRefusal(tx, input.leadId);
            if (refusal) throw new ReassignError("visit_booked", refusal, 409);
        }

        await tx.execute(sql`
            UPDATE dealer_leads
            SET current_owner_id = ${input.targetUserId},
                assigned_at = NOW(),
                updated_at = NOW()
                ${handBack ? sql`, pre_transfer_status = NULL` : sql``}
            WHERE id = ${input.leadId}
        `);
        const closedVisits = handBack
            ? await releaseAsm(tx, input.leadId, `Closed: lead handed back to ${target.name ?? "an inside-sales rep"}`)
            : 0;
        const backTo = handBack ? statusBeforeTransfer(locked[0]?.pre_transfer_status ?? null) : null;

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "ownership_transfer",
                performedBy: input.actorId,
                remarks: input.reason,
                // E-295: the caller's assertOwner proved the actor held the lead
                // (ID 155: or the manager path proved who did).
                fromOwnerId,
                toOwnerId: input.targetUserId,
                ...(backTo
                    ? {
                          statusChange: {
                              from: "Transferred_to_ASM" as LeadStatus,
                              to: backTo,
                              event: "correction" as const,
                              reasonNotes: `Handed back to ${target.name ?? "an inside-sales rep"} before the field visit; back to the pre-transfer stage. ${releaseNote(closedVisits)}`,
                          },
                      }
                    : {}),
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
