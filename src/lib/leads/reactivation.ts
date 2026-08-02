// BRD §0.9 — unified Lost-lead reactivation procedure.
//
// Any path that re-engages a Lost lead runs this SAME procedure: admin manual
// "Reactivate Lost Lead", bulk-upload phone match on a Lost row, or AI dialer
// re-engagement. No 90-day cutoff — a Lost lead can be reactivated at any age.
//
// Procedure (single transaction):
//   - lead_status → Assigned_Not_Contacted  (originator still active → routed
//     back to them)  OR  New_Unassigned  (originator gone → admin reassigns).
//     Never directly to Under_Discussion — the new owner must engage first.
//   - lost_reason → NULL ; previous_lost_reason ← the prior lost_reason.
//   - closed_at / closing_owner_id / closing_role → NULL.
//   - assigned_at = NOW() when an owner is routed.
//   - dealer_lead_status_history row + a reactivated_via_* touchpoint.
//
// Runs its own transaction rather than going through writeTouchpoint() because
// the status target varies (New_Unassigned is not in the transition map) and
// the owner-routing + previous_lost_reason writes are reactivation-specific.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

import { dealerLeads, users, dealerLeadStatusHistory, leadTouchpoints } from "@/lib/db/schema";

export type ReactivationTrigger = "admin" | "upload" | "ai_dialer";

const TRIGGER_TOUCHPOINT: Record<ReactivationTrigger, string> = {
    admin: "reactivated_via_admin",
    upload: "reactivated_via_upload",
    ai_dialer: "reactivated_via_ai_dialer",
};

export type ReactivationResult = {
    new_status: "Assigned_Not_Contacted" | "New_Unassigned";
    new_owner_id: string | null;
};

export async function reactivateLead(opts: {
    leadId: string;
    trigger: ReactivationTrigger;
    performedBy: string | null;
    notes?: string | null;
}): Promise<ReactivationResult> {
    const { leadId, trigger, performedBy } = opts;

    return db.transaction(async (tx) => {
        const leadRows = await tx.execute<{
            lead_status: string | null;
            lost_reason: string | null;
            originator_id: string | null;
        }>(sql`
            SELECT lead_status, lost_reason, originator_id
            FROM ${dealerLeads} WHERE id = ${leadId} LIMIT 1
        `);
        const lead = leadRows[0];
        if (!lead) throw new Error("Lead not found.");
        if (lead.lead_status !== "Lost") {
            throw new Error("Only a Lost lead can be reactivated (BRD §0.9).");
        }

        // Owner routing — the originator gets the lead back if still active.
        let newOwnerId: string | null = null;
        if (lead.originator_id) {
            const owners = await tx.execute<{ id: string; is_active: boolean | null }>(sql`
                SELECT id::text AS id, is_active FROM ${users}
                WHERE id::text = ${lead.originator_id} LIMIT 1
            `);
            if (owners[0] && owners[0].is_active !== false) {
                newOwnerId = owners[0].id;
            }
        }
        const newStatus = newOwnerId
            ? "Assigned_Not_Contacted"
            : "New_Unassigned";

        await tx.execute(sql`
            UPDATE ${dealerLeads} SET
                lead_status = ${newStatus},
                lost_reason = NULL,
                previous_lost_reason = ${lead.lost_reason},
                closed_at = NULL,
                closing_owner_id = NULL,
                closing_role = NULL,
                current_owner_id = ${newOwnerId},
                assigned_at = ${newOwnerId ? sql`NOW()` : sql`assigned_at`},
                updated_at = NOW()
            WHERE id = ${leadId}
        `);

        // Status-history audit — every reactivation event recorded (BRD §0.9).
        await tx.execute(sql`
            INSERT INTO ${dealerLeadStatusHistory}
                (dealer_lead_id, from_status, to_status, from_lost_reason,
                 changed_by, changed_at, reason_notes)
            VALUES (${leadId}, 'Lost', ${newStatus}, ${lead.lost_reason},
                ${performedBy ?? "system"}, NOW(),
                ${opts.notes ?? `Reactivated from Lost via ${trigger}`})
        `);

        // reactivated_via_* touchpoint — keeps the unified history complete.
        await tx.execute(sql`
            INSERT INTO ${leadTouchpoints}
                (dealer_lead_id, touchpoint_type, performed_by, performed_at,
                 remarks, sync_method)
            VALUES (${leadId}, ${TRIGGER_TOUCHPOINT[trigger]}, ${performedBy},
                NOW(), ${opts.notes ?? `Reactivated from Lost via ${trigger}`},
                ${performedBy ? "manual" : "system"})
        `);

        return { new_status: newStatus, new_owner_id: newOwnerId };
    });
}
