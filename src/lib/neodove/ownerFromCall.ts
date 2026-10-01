// Ownership events from NeoDove calls (tracker ID 83 / 63, handover P2-11,
// 29 Sep 2026).
//
//   First human call. The owner of an unowned lead is the LINKED NeoDove agent
//   (agent map, agentMap.ts) who made the first human call to it — whatever the
//   outcome. Not the push, not the dial request (ASSIGN_ON_PUSH is off).
//   Backfill. Linking an agent later assigns the unowned leads that agent had
//   already called, dated at the original call, so the owner clock starts when
//   the work started.
//   On your behalf. A call by an agent who is not the owner, after the owner
//   asked "Call this lead now" (a neodove_dial_request by the owner in the last
//   24 h), is marked called_on_behalf (E-314).
//
// Every assignment writes an ownership hop (from nobody → the agent) with the
// reason, through writeTouchpoint. Best-effort: an inbound event is never
// refused because the owner could not be set.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isForward } from "@/lib/lifecycle/statusRules";
import { markSalesReady } from "@/lib/leads/salesReady";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function assignIfUnowned(
    tx: Tx,
    leadId: string,
    agentUserId: string,
    callAt: Date,
    reason: string,
): Promise<boolean> {
    const rows = (await tx.execute<{ lead_status: string | null }>(sql`
        UPDATE dealer_leads
           SET current_owner_id = ${agentUserId},
               originator_id = COALESCE(originator_id, ${agentUserId}),
               assigned_at = ${callAt.toISOString()}::timestamptz,
               updated_at = NOW()
         WHERE id = ${leadId}
           AND current_owner_id IS NULL
           AND lead_status IS DISTINCT FROM 'Converted'
           AND lead_status IS DISTINCT FROM 'Lost'
        RETURNING lead_status
    `)) as unknown as Array<{ lead_status: string | null }>;
    if (!rows[0]) return false;
    const from = rows[0].lead_status;
    // ID 82: a NeoDove pick-up is a Sales-ready event, dated at the call.
    await markSalesReady(tx, { leadId, reason: "neodove_pickup", actorId: agentUserId, at: callAt });
    await writeTouchpoint(
        {
            dealerLeadId: leadId,
            touchpointType: "lead_assigned",
            performedBy: agentUserId,
            performedAt: callAt,
            remarks: reason,
            externalSystem: "neodove",
            syncMethod: "system",
            fromOwnerId: null,
            toOwnerId: agentUserId,
            statusChange: isForward(from, "Assigned_Not_Contacted")
                ? { from: from as LeadStatus | null, to: "Assigned_Not_Contacted", event: "progress" }
                : undefined,
        },
        { tx },
    );
    return true;
}

/** After an inbound NeoDove call is written: owner on first human call, and on-behalf marking. */
export async function applyNeodoveCallOwnership(input: {
    leadId: string;
    touchpointId: string;
    agentUserId: string | null;
    callAt: Date;
}): Promise<{ assigned: boolean; onBehalf: boolean }> {
    if (!input.agentUserId) return { assigned: false, onBehalf: false };
    const agent = input.agentUserId;
    try {
        return await db.transaction(async (tx) => {
            const assigned = await assignIfUnowned(
                tx,
                input.leadId,
                agent,
                input.callAt,
                "Owner: first human call by the linked NeoDove agent.",
            );
            if (assigned) return { assigned, onBehalf: false };

            const behalf = (await tx.execute<{ yes: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1 FROM dealer_leads dl
                      JOIN lead_touchpoints r ON r.dealer_lead_id = dl.id
                     WHERE dl.id = ${input.leadId}
                       AND dl.current_owner_id IS NOT NULL
                       AND dl.current_owner_id <> ${agent}
                       AND r.touchpoint_type = 'neodove_dial_request'
                       AND r.performed_by = dl.current_owner_id
                       AND r.performed_at >= ${input.callAt.toISOString()}::timestamptz - INTERVAL '24 hours'
                       AND r.performed_at <= ${input.callAt.toISOString()}::timestamptz
                ) AS yes
            `)) as unknown as Array<{ yes: boolean }>;
            const onBehalf = !!behalf[0]?.yes;
            if (onBehalf) {
                await tx.execute(sql`
                    UPDATE lead_touchpoints SET called_on_behalf = TRUE
                     WHERE touchpoint_id = ${input.touchpointId}::uuid
                `);
            }
            return { assigned: false, onBehalf };
        });
    } catch (err) {
        console.error("[neodove/ownerFromCall] not applied:", err instanceof Error ? err.message : err);
        return { assigned: false, onBehalf: false };
    }
}

/**
 * Linking an agent: every still-unowned lead whose FIRST human NeoDove call was
 * by this agent (now attributed to the user) is assigned to them, dated at that
 * call. Runs on the mapping transaction.
 */
export async function backfillOwnersForLinkedAgent(tx: Tx, userId: string): Promise<number> {
    const firsts = (await tx.execute<{ lead_id: string; first_at: string }>(sql`
        SELECT DISTINCT ON (t.dealer_lead_id) t.dealer_lead_id AS lead_id, t.performed_at::text AS first_at, t.performed_by
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'inside_sales_call'
           AND t.external_system = 'neodove'
           AND dl.current_owner_id IS NULL
           AND dl.lead_status IS DISTINCT FROM 'Converted'
           AND dl.lead_status IS DISTINCT FROM 'Lost'
         ORDER BY t.dealer_lead_id, t.performed_at ASC
    `)) as unknown as Array<{ lead_id: string; first_at: string; performed_by: string | null }>;
    let n = 0;
    for (const f of firsts) {
        if (f.performed_by !== userId) continue;
        const ok = await assignIfUnowned(
            tx,
            f.lead_id,
            userId,
            new Date(f.first_at),
            "Owner: first human call by this NeoDove agent (assigned when the agent was linked).",
        );
        if (ok) n++;
    }
    return n;
}
