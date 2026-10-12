// An escalation resolved with "Reassign" (POST /api/admin/escalations/[id]/resolve,
// BRD §0.3 Path D). Extracted so the hand-back rule (tracker ID 121,
// asmHandBack.ts) applies here exactly as it does in assignOwner.ts and
// reassign.ts: a lead Awaiting field visit given to an ISR / partner is refused
// while the ASM has a visit or a follow-up booked, and otherwise goes back to
// its pre-transfer stage with the ASM unlinked and the open visits closed.
//
// Runs inside the caller's transaction: the owner swap, the hand-back, the
// Sales-ready event and the touchpoint commit together.

import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { markSalesReady } from "@/lib/leads/salesReady";
import { statusBeforeTransfer } from "@/lib/leads/assignOwner";
import {
    AsmVisitBookedError,
    handBackRefusal,
    isHandBack,
    releaseAsm,
    releaseNote,
} from "@/lib/leads/asmHandBack";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EscalationTargetError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404,
    ) {
        super(message);
        this.name = "EscalationTargetError";
    }
}

export type EscalationReassignInput = {
    leadId: string;
    actorId: string;
    targetUserId: string;
    notes: string;
};

/**
 * Hand the lead to the target user and write the escalation_resolved_reassign
 * touchpoint. Throws EscalationTargetError (400/404) for a bad target and
 * AsmVisitBookedError (409) when the hand-back is refused — nothing is written.
 */
export async function reassignFromEscalation(
    tx: Tx,
    input: EscalationReassignInput,
): Promise<{ handedBack: boolean; closedVisits: number }> {
    const targets = (await tx.execute<{ id: string; is_active: boolean | null; role: string | null; name: string | null }>(sql`
        SELECT id::text AS id, is_active, role, name FROM users
         WHERE id::text = ${input.targetUserId} LIMIT 1
    `)) as unknown as Array<{ id: string; is_active: boolean | null; role: string | null; name: string | null }>;
    const target = targets[0];
    if (!target) throw new EscalationTargetError("Target user not found.", 404);
    if (target.is_active === false) throw new EscalationTargetError("Target user is inactive.", 400);

    const locked = (await tx.execute<{
        current_owner_id: string | null;
        lead_status: string | null;
        pre_transfer_status: string | null;
    }>(sql`
        SELECT current_owner_id, lead_status, pre_transfer_status
          FROM dealer_leads WHERE id = ${input.leadId} FOR UPDATE
    `)) as unknown as Array<{ current_owner_id: string | null; lead_status: string | null; pre_transfer_status: string | null }>;
    const prev = locked[0];

    const handBack = isHandBack(prev?.lead_status, target.role);
    if (handBack) {
        const refusal = await handBackRefusal(tx, input.leadId);
        if (refusal) throw new AsmVisitBookedError(refusal);
    }

    await tx.execute(sql`
        UPDATE dealer_leads
           SET current_owner_id = ${target.id},
               assigned_at = NOW(),
               updated_at = NOW()
               ${handBack ? sql`, pre_transfer_status = NULL` : sql``}
         WHERE id = ${input.leadId}
    `);
    const closedVisits = handBack
        ? await releaseAsm(tx, input.leadId, `Closed: lead handed back to ${target.name ?? "an inside-sales rep"}`)
        : 0;
    const backTo = handBack ? statusBeforeTransfer(prev?.pre_transfer_status ?? null) : null;

    // ID 82: an owner given by an admin is a Sales-ready event (a no-op when
    // the lead already has one — the first event wins).
    await markSalesReady(tx, { leadId: input.leadId, reason: "admin_assigned", actorId: input.actorId });

    await writeTouchpoint(
        {
            dealerLeadId: input.leadId,
            touchpointType: "escalation_resolved_reassign",
            performedBy: input.actorId,
            remarks: input.notes,
            // E-295: the hop this resolution records, for Lead Tracking.
            fromOwnerId: prev?.current_owner_id ?? null,
            toOwnerId: target.id,
            ...(backTo
                ? {
                      statusChange: {
                          from: "Transferred_to_ASM" as LeadStatus,
                          to: backTo,
                          event: "correction" as const,
                          reasonNotes: `Escalation resolved: reassigned to ${target.name ?? "an inside-sales rep"} before the field visit; back to the pre-transfer stage. ${releaseNote(closedVisits)}`,
                      },
                  }
                : {}),
        },
        { tx },
    );
    return { handedBack: handBack, closedVisits };
}
