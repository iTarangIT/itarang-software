// Ownership events from NeoDove calls (tracker ID 83 / 63, handover P2-11,
// 29 Sep 2026; review of 30 Sep).
//
//   First human call. The owner of an unowned lead is the LINKED NeoDove agent
//   (agent map, agentMap.ts) who made the first human call to it — whatever the
//   outcome. Not the push, not the dial request (ASSIGN_ON_PUSH is off).
//   Caller not linked. When that first call was made by an agent who is not
//   linked to a CRM user, the lead stays unowned and is FLAGGED: it is waiting
//   on a link, not on a rep (callerNotLinkedFor / callerNotLinkedCounts).
//   Backfill. Linking an agent later assigns exactly those leads, dated at the
//   original call, so the owner clock starts when the work started.
//   On your behalf. A call by anyone other than the owner, after the owner
//   asked "Call this lead now" (a neodove_dial_request by the owner in the last
//   24 h), is marked called_on_behalf (E-314) and the owner is told.
//
// "First call" always means the first human NeoDove call SINCE THE LEAD LAST
// BECAME UNOWNED (FIRST_CALL_SINCE_UNOWNED). A lead an owner once held and an
// admin released is unowned on purpose: the calls made before that release
// must not hand it back, least of all dated at the old call.
//
// Every assignment writes an ownership hop (from nobody → the agent) with the
// reason, through writeTouchpoint. Best-effort: an inbound event is never
// refused because the owner could not be set.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isForward } from "@/lib/lifecycle/statusRules";
import { markSalesReady } from "@/lib/leads/salesReady";
import { notifyUser } from "@/lib/notifications/notify";
import { agentKey } from "@/lib/neodove/agentMapRules";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "execute">;

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

export type CallOwnershipInput = {
    leadId: string;
    touchpointId: string;
    /** The CRM user this NeoDove agent is linked to, or null when the agent is not linked. */
    agentUserId: string | null;
    callAt: Date;
    /** The agent's name as NeoDove sent it — for the owner's notification. */
    agentName?: string | null;
};

export type CallOwnershipResult = {
    assigned: boolean;
    onBehalf: boolean;
    /** Set with onBehalf: the owner who asked for the call, to be told after the commit. */
    owner: { id: string; dealerName: string | null } | null;
};

/**
 * The writes for one inbound call, on the caller's transaction: the first-call
 * owner, else the on-behalf mark. No notification — that is after the commit.
 */
export async function resolveCallOwnership(tx: Tx, input: CallOwnershipInput): Promise<CallOwnershipResult> {
    const agent = input.agentUserId;
    if (agent) {
        const assigned = await assignIfUnowned(
            tx,
            input.leadId,
            agent,
            input.callAt,
            "Owner: first human call by the linked NeoDove agent.",
        );
        if (assigned) return { assigned, onBehalf: false, owner: null };
    }

    // The caller is not the owner — a linked agent who is someone else, or an
    // agent nobody has linked yet — and the owner asked for this call in the
    // last 24 hours.
    const behalf = (await tx.execute<{ owner_id: string; dealer_name: string | null }>(sql`
        SELECT dl.current_owner_id AS owner_id, COALESCE(dl.shop_name, dl.dealer_name) AS dealer_name
          FROM dealer_leads dl
         WHERE dl.id = ${input.leadId}
           AND dl.current_owner_id IS NOT NULL
           AND dl.current_owner_id IS DISTINCT FROM ${agent}::text
           AND EXISTS (
                SELECT 1 FROM lead_touchpoints r
                 WHERE r.dealer_lead_id = dl.id
                   AND r.touchpoint_type = 'neodove_dial_request'
                   AND r.performed_by = dl.current_owner_id
                   AND r.performed_at >= ${input.callAt.toISOString()}::timestamptz - INTERVAL '24 hours'
                   AND r.performed_at <= ${input.callAt.toISOString()}::timestamptz
           )
         LIMIT 1
    `)) as unknown as Array<{ owner_id: string; dealer_name: string | null }>;
    const owner = behalf[0] ?? null;
    if (!owner) return { assigned: false, onBehalf: false, owner: null };
    await tx.execute(sql`
        UPDATE lead_touchpoints SET called_on_behalf = TRUE
         WHERE touchpoint_id = ${input.touchpointId}::uuid
    `);
    return { assigned: false, onBehalf: true, owner: { id: owner.owner_id, dealerName: owner.dealer_name } };
}

/** After an inbound NeoDove call is written: owner on first human call, and on-behalf marking. */
export async function applyNeodoveCallOwnership(
    input: CallOwnershipInput,
): Promise<{ assigned: boolean; onBehalf: boolean }> {
    let result: CallOwnershipResult;
    try {
        result = await db.transaction((tx) => resolveCallOwnership(tx, input));
    } catch (err) {
        console.error("[neodove/ownerFromCall] not applied:", err instanceof Error ? err.message : err);
        return { assigned: false, onBehalf: false };
    }

    // The owner asked for this call; tell them it happened. After the commit and
    // best-effort — a notification must never undo the marking.
    if (result.owner) {
        try {
            const who = input.agentName?.trim() || "A NeoDove agent";
            await notifyUser(result.owner.id, {
                type: "lead.called_on_behalf",
                title: "Your lead was called on your behalf",
                message: `${who} called ${result.owner.dealerName ?? "your lead"} after your "Call now" request. The call is on the lead's timeline.`,
                leadId: input.leadId,
                data: { touchpoint_id: input.touchpointId },
            });
        } catch (err) {
            console.error("[neodove/ownerFromCall] owner not notified:", err instanceof Error ? err.message : err);
        }
    }
    return { assigned: result.assigned, onBehalf: result.onBehalf };
}

type FirstCall = { lead_id: string; first_at: string; performed_by: string | null; agent_name: string | null };

/**
 * For every unowned, open lead: its FIRST human NeoDove call since it last
 * became unowned.
 *
 *   never owned (no ownership hop at all)        → every call counts
 *   released (the last hop handed it to nobody)   → only calls after that hop
 *   last hop gave it an owner, yet nobody owns it → a release nobody recorded:
 *                                                   the lead is left alone
 */
function firstCallsSinceUnowned(exec: Executor, leadId?: string): Promise<FirstCall[]> {
    return exec.execute<FirstCall>(sql`
        SELECT DISTINCT ON (t.dealer_lead_id)
               t.dealer_lead_id AS lead_id,
               t.performed_at::text AS first_at,
               t.performed_by,
               t.external_agent_name AS agent_name
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
          LEFT JOIN LATERAL (
              SELECT h.performed_at, h.to_owner_id
                FROM lead_touchpoints h
               WHERE h.dealer_lead_id = dl.id
                 AND (h.from_owner_id IS NOT NULL OR h.to_owner_id IS NOT NULL)
               ORDER BY h.performed_at DESC
               LIMIT 1
          ) last_hop ON TRUE
         WHERE t.touchpoint_type = 'inside_sales_call'
           AND t.external_system = 'neodove'
           AND dl.current_owner_id IS NULL
           AND dl.lead_status IS DISTINCT FROM 'Converted'
           AND dl.lead_status IS DISTINCT FROM 'Lost'
           AND (last_hop.performed_at IS NULL
                OR (last_hop.to_owner_id IS NULL AND t.performed_at > last_hop.performed_at))
           ${leadId ? sql`AND dl.id = ${leadId}` : sql``}
         ORDER BY t.dealer_lead_id, t.performed_at ASC
    `) as unknown as Promise<FirstCall[]>;
}

/**
 * Linking an agent: every still-unowned lead whose FIRST human NeoDove call
 * since it became unowned was by this agent (now attributed to the user) is
 * assigned to them, dated at that call. Runs on the mapping transaction.
 */
export async function backfillOwnersForLinkedAgent(tx: Tx, userId: string): Promise<number> {
    const firsts = await firstCallsSinceUnowned(tx);
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

/**
 * "Caller not linked" — per NeoDove agent (agentKey), how many unowned leads
 * that agent called first while not linked to a CRM user. These are the leads
 * linking the agent will assign. Shown on NeoDove › Agents.
 */
export async function callerNotLinkedCounts(exec: Executor = db): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const f of await firstCallsSinceUnowned(exec)) {
        if (f.performed_by) continue;
        const k = agentKey(f.agent_name);
        if (!k) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
}

/**
 * The "caller not linked" flag for one lead: the unlinked agent who made its
 * first human call, or null when the lead is owned, was never called, or was
 * first called by a linked agent. Never throws — it decorates a lead page.
 */
export async function callerNotLinkedFor(
    leadId: string,
    exec: Executor = db,
): Promise<{ agent_name: string | null; first_call_at: string } | null> {
    try {
        const [f] = await firstCallsSinceUnowned(exec, leadId);
        if (!f || f.performed_by) return null;
        const at = new Date(f.first_at);
        return {
            agent_name: f.agent_name?.trim() || null,
            // ISO: the lead page formats it in the browser.
            first_call_at: Number.isNaN(at.getTime()) ? f.first_at : at.toISOString(),
        };
    } catch (err) {
        console.warn("[neodove/ownerFromCall] caller-not-linked flag skipped:", err instanceof Error ? err.message : err);
        return null;
    }
}
