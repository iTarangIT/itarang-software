// CRM-side co-assignment for NeoDove pushes (E-237).
//
// THE PROBLEM THIS SOLVES. A lead handed to a NeoDove campaign reaches the
// calling team but stays unowned here: current_owner_id is left NULL, so it sits
// on nobody's dashboard while a NeoDove agent is actively calling it. The CRM
// and the calling team disagree about who owns it, and neither says so.
//
// WHAT THIS IS NOT. It does not tell NeoDove anything. Their Custom Integration
// endpoint has no assignee/agent/owner parameter and they have no read API, so
// their agent list can be neither written nor mirrored (docs/neodove-contract.md
// §2). Assignment there is campaign members + lead distribution, set in their UI
// by a human. This records the CRM counterpart of that choice.
//
// WHY IT LIVES HERE AND NOT IN pushOneLead(). pushOne.ts is explicit that it
// writes no touchpoints — pushing 500 leads must not write 500 timeline entries.
// That contract is worth keeping, and an ownership change is a different kind of
// event from a push: it is a material, audited change that BRD §0.11 requires a
// touchpoint for. So the push stays silent and the assignment, which is a policy
// decision the caller opts into, lives one layer up.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import {
    assignLeadOwner,
    resolveAssignTarget,
    type AssignTarget,
} from "@/lib/leads/assignOwner";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { NEODOVE_ASSIGNEE_ROLES } from "./roles";

/**
 * The campaign's default CRM owner.
 *
 * Read through to_jsonb rather than naming the column: a missing column fails a
 * statement at PARSE time, which would take every push route down on a DB
 * without E-237 rather than simply not assigning anything. Same idiom as
 * getPriorityDialCampaign().
 */
export async function getCampaignCrmOwner(
    campaignId: string,
): Promise<string | null> {
    const rows = await db.execute<{ crm_owner_user_id: string | null }>(sql`
        SELECT to_jsonb(c) ->> 'crm_owner_user_id' AS crm_owner_user_id
          FROM neodove_campaigns c
         WHERE c.id = ${campaignId}
         LIMIT 1
    `);
    return rows[0]?.crm_owner_user_id ?? null;
}

export type ResolveAssigneeResult =
    | { ok: true; target: AssignTarget | null }
    | { ok: false; status: number; message: string };

/**
 * Decide who — if anyone — this push assigns its leads to.
 *
 * `assignToUserId` semantics, which the three states of the modal's picker map
 * onto directly:
 *   undefined → fall back to the campaign's default owner
 *   null      → "don't assign", even though the campaign has a default
 *   string    → assign to this user, overriding the campaign default
 *
 * CALL THIS IN THE REQUEST HANDLER, BEFORE ANY LEAD IS PUSHED. The batch and
 * audience routes ack and then drain inside after(), where there is no response
 * left to report a bad user id on — validating there would turn a typo into a
 * silent no-op that looks like success. Validating here makes it a 400 before a
 * single lead moves.
 */
export async function resolveNeodoveAssignee(input: {
    campaignId: string;
    assignToUserId?: string | null;
}): Promise<ResolveAssigneeResult> {
    const explicit = input.assignToUserId;
    if (explicit === null) return { ok: true, target: null };

    const userId = explicit ?? (await getCampaignCrmOwner(input.campaignId));
    if (!userId) return { ok: true, target: null };

    const resolved = await resolveAssignTarget(userId);
    if (!resolved.ok) {
        return { ok: false, status: resolved.status, message: resolved.message };
    }

    const role = (resolved.target.role ?? "").toLowerCase();
    if (!NEODOVE_ASSIGNEE_ROLES.includes(role)) {
        return {
            ok: false,
            status: 400,
            message:
                `${resolved.target.name ?? "That user"} is a ${resolved.target.role ?? "user with no role"}, ` +
                `which has no lead queue to receive pushed leads — they would be assigned and then visible to nobody. ` +
                `Pick one of: ${NEODOVE_ASSIGNEE_ROLES.join(", ")}.`,
        };
    }

    return { ok: true, target: resolved.target };
}

/**
 * Assign one pushed lead to the resolved owner.
 *
 * NEVER THROWS. An assignment is a consequence of the push, not a precondition
 * for it: by the time this runs the lead is already at NeoDove and that cannot
 * be undone. So a failure here must cost the assignment and nothing else — it
 * must not mark the push failed, must not touch push_error, and must not move
 * total_pushed / push_failed, all of which reconciliation later diffs against.
 *
 * Returns whether the lead ended up assigned.
 */
export async function assignAfterPush(input: {
    leadId: string;
    campaignId: string;
    target: AssignTarget;
    actorId: string;
    actorRole: string | null | undefined;
    campaignLabel: string;
}): Promise<boolean> {
    try {
        // Re-read the status rather than trusting the drain's opening SELECT:
        // a 500-lead batch takes minutes, and the lead may have been claimed or
        // closed in the meantime. assignLeadOwner branches on this value, so a
        // stale one would lift a status that has already moved.
        const rows = await db.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
        `);
        if (!rows[0]) return false;

        await assignLeadOwner({
            leadId: input.leadId,
            fromStatus: rows[0].lead_status as LeadStatus | null,
            target: input.target,
            actorId: input.actorId,
            actorRole: input.actorRole,
            touchpointType: "lead_assigned",
            externalSystem: "neodove",
            remarks:
                `Assigned to ${input.target.name ?? input.target.id} on hand-off to NeoDove campaign ` +
                `"${input.campaignLabel}". NeoDove has no assignee API — this mirrors the assignment ` +
                `made in that campaign's own settings.`,
        });

        // Best-effort, and nested on purpose: without E-237 this UPDATE fails at
        // PARSE time, and that must cost the audit stamp rather than undoing an
        // assignment that has already committed.
        try {
            await db.execute(sql`
                UPDATE neodove_lead_links
                   SET assigned_owner_id = ${input.target.id}, assigned_at = NOW()
                 WHERE dealer_lead_id = ${input.leadId}
                   AND neodove_campaign_id = ${input.campaignId}
            `);
        } catch (err) {
            console.warn(
                `[NeoDove/assign] link stamp skipped for ${input.leadId} (E-237 applied?):`,
                errorMessage(err),
            );
        }

        return true;
    } catch (err) {
        console.error(
            `[NeoDove/assign] failed for lead ${input.leadId}:`,
            errorMessage(err),
        );
        return false;
    }
}

/**
 * Record the batch outcome where the operator can actually see it.
 *
 * The HTTP ack is returned before the drain runs, so it can only ever state
 * intent. This row is the authoritative answer to "did those leads actually get
 * assigned", and it renders on the existing Sync Activity screen with no new UI.
 * Best-effort, exactly like logSyncEvent: a ledger write must never be the thing
 * that fails a push.
 */
export async function logAssignmentSummary(input: {
    campaignId: string;
    target: AssignTarget;
    eligible: number;
    assigned: number;
    assignFailed: number;
}): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO neodove_sync_events
                (direction, event_type, neodove_campaign_id, request_payload, error, attempts)
            VALUES ('outbound', 'assign_owner', ${input.campaignId},
                    ${JSON.stringify({
                        ownerUserId: input.target.id,
                        ownerName: input.target.name,
                        eligible: input.eligible,
                        assigned: input.assigned,
                        assignFailed: input.assignFailed,
                    })}::jsonb,
                    ${
                        input.assignFailed > 0
                            ? `${input.assignFailed} assignment(s) failed`
                            : null
                    },
                    0)
        `);
    } catch (err) {
        console.warn("[NeoDove/assign] summary not logged:", errorMessage(err));
    }
}
