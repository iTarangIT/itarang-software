// The single owner-assignment writer for dealer_leads.
//
// Extracted verbatim from POST /api/admin/leads/bulk's reassign branch when the
// NeoDove push became a second caller of the same sequence. That sequence is not
// one UPDATE — it is five coupled writes (current_owner_id, a COALESCE'd
// originator_id, assigned_at, updated_at, and a writeTouchpoint that may also
// lift lead_status) — and which of them run depends on the TARGET'S ROLE and the
// lead's current position in the BRD §0.7 lifecycle.
//
// Two copies of that would drift, and the drift would be invisible: a copy that
// forgets originator_id still assigns the lead correctly and still shows up on
// the right queue, while silently breaking originator attribution (which is what
// reactivation routes a revived lead back to) for months before anyone notices.
//
// WHY THE STATUS LIFT IS NOT OPTIONAL. Every workspace queue filters on
// lead_status: /inside-sales "My Open Leads" needs `lead_status IN
// (OPEN_STATUSES)` and "Unassigned (Claim)" needs `current_owner_id IS NULL`.
// A lead given an owner but left at lead_status = NULL therefore satisfies
// NEITHER and lands on nobody's page — the exact bug E-140 was written to
// repair. Manual-upload and scraped leads start life at NULL on purpose (so the
// AI dialer can cold-dial them, see ai-dialer/exclusionFilter), so this is the
// common case, not an edge case. Assigning such a lead must LIFT it into the
// pipeline, not just swap the owner.
//
// NOTE the asymmetry that follows from that: only the `asm` and
// `inside_sales_rep` branches lift the status, because only those two roles have
// a workspace queue to lift into. Any other role takes the plain-swap branch and
// leaves a NULL-status lead invisible. Callers that let a human pick the target
// must therefore constrain the role list themselves — see NEODOVE_ASSIGNEE_ROLES
// in src/lib/neodove/roles.ts for the precedent.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";
import {
    canTransition,
    isOpen,
    isTerminal,
    type LeadStatus,
} from "@/lib/lifecycle/transitions";

export type AssignTarget = {
    /** users.id::text — dealer_leads.current_owner_id is text, users.id is uuid. */
    id: string;
    name: string | null;
    role: string | null;
};

export type ResolveAssignTargetResult =
    | { ok: true; target: AssignTarget }
    | { ok: false; status: 400 | 404; message: string };

/**
 * Resolve and validate an assignment target: exists, is active, and carries a
 * role. Lifted from bulk/route.ts so every caller rejects a dead user the same
 * way rather than assigning leads into a void.
 */
export async function resolveAssignTarget(
    userId: string,
): Promise<ResolveAssignTargetResult> {
    const targets = await db.execute<{
        id: string;
        name: string | null;
        is_active: boolean | null;
        role: string | null;
    }>(sql`
        SELECT id::text AS id, name, is_active, role FROM users
        WHERE id::text = ${userId} LIMIT 1
    `);
    if (!targets[0]) {
        return { ok: false, status: 404, message: "Target user not found." };
    }
    if (targets[0].is_active === false) {
        return { ok: false, status: 400, message: "Target user is inactive." };
    }
    return {
        ok: true,
        target: {
            id: targets[0].id,
            name: targets[0].name,
            role: targets[0].role,
        },
    };
}

// Which branch ran — for the caller's aggregate counts and for logging. There
// is deliberately no "refused" member: a blocked transition falls through to the
// plain swap rather than aborting, so the lead still changes hands and still
// gets an audit row. Assignment never silently does nothing.
export type AssignPath = "asm_swap" | "asm_lift" | "rep_lift" | "owner_swap";

export type AssignOutcome = {
    assigned: boolean;
    path: AssignPath;
    /** Non-null only when this call changed lead_status. */
    statusLiftedTo: LeadStatus | null;
};

export type AssignLeadOwnerInput = {
    leadId: string;
    /**
     * The lead's status BEFORE this call. Passed in rather than re-read: the
     * bulk path already has it from one batch SELECT, and re-reading per lead
     * would add a round trip per row to a 5000-row loop.
     */
    fromStatus: LeadStatus | null;
    target: AssignTarget;
    actorId: string;
    actorRole: string | null | undefined;
    remarks: string;
    /**
     * Timeline entry type for the non-ASM branches. Defaults to
     * "ownership_transfer" so the bulk route's behaviour is unchanged; the
     * NeoDove push passes "lead_assigned". ASM branches always use
     * "asm_transfer" — that is what the ASM timeline reads.
     */
    touchpointType?: TouchpointType;
    externalSystem?: string | null;
};

/**
 * Assign ONE lead to ONE user, lifting its lifecycle status when the target's
 * role has a queue to lift it into.
 *
 * Callers that already own an outer transaction are not supported: writeTouchpoint
 * opens its own, and the UPDATE below deliberately commits separately so a
 * touchpoint failure cannot roll back an assignment that already happened on a
 * path (NeoDove) whose network side effect is unrollbackable anyway.
 */
export async function assignLeadOwner(
    input: AssignLeadOwnerInput,
): Promise<AssignOutcome> {
    const {
        leadId,
        fromStatus,
        target,
        actorId,
        actorRole,
        remarks,
        externalSystem = null,
    } = input;
    const touchpointType = input.touchpointType ?? "ownership_transfer";

    // A lead is "in the BRD pipeline" only once it carries a real lifecycle
    // status. NULL / legacy statuses belong to no workspace queue.
    const inPipeline = !!fromStatus && (isOpen(fromStatus) || isTerminal(fromStatus));

    // ── ASM target: mirror the inside-sales "transfer to ASM" flow.
    //
    // BRD §0.7's transition map only allows Transferred_to_ASM from
    // Under_Discussion / Commercials_Explained / Commercials_Finalised — an
    // engagement-first rule for inside-sales reps. Admin bulk reassign is the
    // BRD §0.12 documented exception to that (e.g. a CEO "Recommend Reassign"
    // after an escalation must be actionable while the lead is still
    // Assigned_Not_Contacted). The required reason text is the audit trail, and
    // pre_transfer_status is stamped so the original state can be restored if
    // the transfer is later rejected.
    if (target.role === "asm") {
        if (fromStatus === "Transferred_to_ASM") {
            // Already an ASM lead — just swap which ASM owns it.
            await db.execute(sql`
                UPDATE dealer_leads
                SET current_owner_id = ${target.id},
                    asm_id = ${target.id},
                    assigned_at = NOW(), updated_at = NOW()
                WHERE id = ${leadId}
            `);
            await writeTouchpoint({
                dealerLeadId: leadId,
                touchpointType: "asm_transfer",
                performedBy: actorId,
                remarks,
                externalSystem,
            });
            return { assigned: true, path: "asm_swap", statusLiftedTo: null };
        }
        if ((fromStatus && isOpen(fromStatus)) || !inPipeline) {
            // Open lead — or a not-yet-in-pipeline manual / scraped lead
            // (NULL / legacy status) — admin override flip to Transferred_to_ASM
            // so it lands on the ASM's queue.
            await db.execute(sql`
                UPDATE dealer_leads
                SET pre_transfer_status = lead_status,
                    current_owner_id = ${target.id},
                    asm_id = ${target.id},
                    assigned_at = NOW(), updated_at = NOW()
                WHERE id = ${leadId}
            `);
            await writeTouchpoint({
                dealerLeadId: leadId,
                touchpointType: "asm_transfer",
                performedBy: actorId,
                remarks,
                externalSystem,
                statusChange: {
                    from: fromStatus ?? "New_Unassigned",
                    to: "Transferred_to_ASM",
                },
            });
            return {
                assigned: true,
                path: "asm_lift",
                statusLiftedTo: "Transferred_to_ASM",
            };
        }
        // Terminal lead (Converted / Lost) — leave lead_status alone and fall
        // through to the plain ownership swap below, which still records the
        // audit touchpoint (no silent reactivation).
    }

    // ── Inside Sales Rep target: lift an unassigned lead into the rep's
    // "active" queue by promoting New_Unassigned → Assigned_Not_Contacted
    // (matches /api/inside-sales/lead/[id]/claim).
    if (
        target.role === "inside_sales_rep" &&
        (fromStatus === "New_Unassigned" || !inPipeline)
    ) {
        // New_Unassigned → Assigned_Not_Contacted is a guarded BRD transition;
        // a not-yet-in-pipeline lead (NULL / legacy status) is an admin lift-in
        // (§0.12) with no prior state to validate.
        const transition =
            fromStatus === "New_Unassigned"
                ? canTransition("New_Unassigned", "Assigned_Not_Contacted", {
                      // canTransition takes `actorRole?: string` — a null role
                      // must arrive as undefined, not null.
                      actorRole: actorRole ?? undefined,
                  })
                : { ok: true as const };
        if (transition.ok) {
            await db.execute(sql`
                UPDATE dealer_leads
                SET current_owner_id = ${target.id},
                    originator_id = COALESCE(originator_id, ${target.id}),
                    assigned_at = NOW(), updated_at = NOW()
                WHERE id = ${leadId}
            `);
            await writeTouchpoint({
                dealerLeadId: leadId,
                touchpointType,
                performedBy: actorId,
                remarks,
                externalSystem,
                statusChange: {
                    from: fromStatus ?? "New_Unassigned",
                    to: "Assigned_Not_Contacted",
                },
            });
            return {
                assigned: true,
                path: "rep_lift",
                statusLiftedTo: "Assigned_Not_Contacted",
            };
        }
        // Transition refused — fall through to the plain swap so the lead still
        // changes hands and still gets an audit row.
    }

    // ── Default: plain ownership swap (other roles, terminal leads, or any
    // case where the role-specific status flip was skipped).
    await db.execute(sql`
        UPDATE dealer_leads
        SET current_owner_id = ${target.id},
            assigned_at = NOW(), updated_at = NOW()
        WHERE id = ${leadId}
    `);
    await writeTouchpoint({
        dealerLeadId: leadId,
        touchpointType,
        performedBy: actorId,
        remarks,
        externalSystem,
    });
    return { assigned: true, path: "owner_swap", statusLiftedTo: null };
}
