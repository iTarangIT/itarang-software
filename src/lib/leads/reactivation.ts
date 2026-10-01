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
// The status move goes through writeTouchpoint (event "reactivation"), like
// every other status writer since the S3 guard came back (ID 115): the history
// row, the touchpoint and the cleared closing fields are its work. Only the
// reactivation-specific writes — owner routing and previous_lost_reason — are
// done here, in the same transaction.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { markSalesReady } from "@/lib/leads/salesReady";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";
import type { LostReason } from "@/lib/lifecycle/transitions";

export type ReactivationTrigger = "admin" | "upload" | "ai_dialer";

const TRIGGER_TOUCHPOINT: Record<ReactivationTrigger, TouchpointType> = {
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
            current_owner_id: string | null;
        }>(sql`
            SELECT lead_status, lost_reason, originator_id, current_owner_id
            FROM dealer_leads WHERE id = ${leadId} LIMIT 1 FOR UPDATE
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
                SELECT id::text AS id, is_active FROM users
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
            UPDATE dealer_leads SET
                previous_lost_reason = ${lead.lost_reason},
                current_owner_id = ${newOwnerId},
                assigned_at = ${newOwnerId ? sql`NOW()` : sql`assigned_at`},
                updated_at = NOW()
            WHERE id = ${leadId}
        `);

        // The status move, its history row (every reactivation is recorded,
        // BRD §0.9), the reactivated_via_* touchpoint and the cleared
        // lost_reason / closed_at / closing_* — one guarded write.
        // E-295: from/to owner recorded so Lead Tracking sees the hop (a Lost
        // lead usually still carries its last owner; reactivation hands it to
        // the originator or back to the pool).
        const notes = opts.notes ?? `Reactivated from Lost via ${trigger}`;
        await writeTouchpoint(
            {
                dealerLeadId: leadId,
                touchpointType: TRIGGER_TOUCHPOINT[trigger],
                performedBy,
                remarks: notes,
                syncMethod: performedBy ? "manual" : "system",
                fromOwnerId: lead.current_owner_id,
                toOwnerId: newOwnerId,
                statusChange: {
                    from: "Lost",
                    to: newStatus,
                    fromLostReason: lead.lost_reason as LostReason | null,
                    reasonNotes: notes,
                    event: "reactivation",
                },
            },
            { tx },
        );

        // ID 82: a reactivated lead is back in the pipeline, so it must be
        // sales-ready — a lead that never was (lost before the event existed)
        // would otherwise sit at New / Unassigned outside Ready to assign.
        // First event wins: an existing date is not moved; the WAIT restarts
        // from this status change (awaitingSince). Savepoint; never throws.
        await markSalesReady(tx, { leadId, reason: "reactivated", actorId: performedBy });

        return { new_status: newStatus, new_owner_id: newOwnerId };
    });
}
