// Owner-initiated reassignment (BRD §0.3 Path C). Extracted from
// POST /api/inside-sales/lead/[id]/reassign so the screen and the WhatsApp
// Assistant reassign exactly the same way. Follow-up carries forward unchanged;
// asm_id is left as it is.
//
// ONE transaction: the owner change and the ownership_transfer touchpoint
// commit together (the route used to run them as two separate statements).
//
// Ownership is the CALLER's job (assertOwner before calling).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REASSIGN_REASON_MIN = 20;

export class ReassignError extends Error {
    constructor(
        readonly code: "self" | "target_not_found" | "target_inactive",
        message: string,
        readonly status: 400 | 404,
    ) {
        super(message);
    }
}

export type ReassignInput = {
    leadId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
};

export async function reassignLead(input: ReassignInput, opts?: { tx?: Tx }): Promise<void> {
    if (input.targetUserId === input.actorId) {
        throw new ReassignError("self", "Cannot reassign to yourself.", 400);
    }
    const run = async (tx: Tx) => {
        const targets = await tx.execute<{ id: string; is_active: boolean | null }>(sql`
            SELECT id::text AS id, is_active FROM users WHERE id::text = ${input.targetUserId} LIMIT 1
        `);
        const target = targets[0];
        if (!target) throw new ReassignError("target_not_found", "Target user not found.", 404);
        if (target.is_active === false) {
            throw new ReassignError("target_inactive", "Target user is inactive.", 400);
        }

        await tx.execute(sql`
            UPDATE dealer_leads
            SET current_owner_id = ${input.targetUserId},
                assigned_at = NOW(),
                updated_at = NOW()
            WHERE id = ${input.leadId}
        `);

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "ownership_transfer",
                performedBy: input.actorId,
                remarks: input.reason,
                // E-295: the caller's assertOwner proved the actor held the lead.
                fromOwnerId: input.actorId,
                toOwnerId: input.targetUserId,
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
