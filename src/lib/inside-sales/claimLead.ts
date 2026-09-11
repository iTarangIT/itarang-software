// Claim a lead from the New_Unassigned queue (BRD §0.3 Path B).
//
// ONE implementation for the single-lead route and the bulk-claim route, so
// the two can never drift in what counts as "claimable" or in the touchpoint
// they leave behind.
//
// Race-safe: the UPDATE carries its own `current_owner_id IS NULL` guard, so
// when two reps claim the same lead at the same moment exactly one wins and
// the other is told "already_owned". The SELECT before it exists only to
// classify a refusal and to capture the previous status for the touchpoint.
//
// Deliberately NOT routed through assignLeadOwner: that helper swaps ownership
// unconditionally and falls through to a plain swap on a blocked transition —
// the opposite of claim semantics, which must refuse an owned lead.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

// Role list + cap are defined in types.ts (client-safe); re-exported here so
// server callers have one import.
export { BULK_CLAIM_CAP, CLAIM_ROLES } from "@/lib/inside-sales/types";

export type ClaimSkipReason = "not_found" | "already_owned" | "terminal";

export type ClaimOutcome =
    | { ok: true }
    | { ok: false; reason: ClaimSkipReason };

export async function claimLead(leadId: string, actorId: string): Promise<ClaimOutcome> {
    const rows = await db.execute<{
        lead_status: string | null;
        current_owner_id: string | null;
    }>(sql`
        SELECT lead_status, current_owner_id
        FROM dealer_leads WHERE id = ${leadId} LIMIT 1
    `);
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.current_owner_id) return { ok: false, reason: "already_owned" };
    // Claimable = unowned and not terminal. NULL / legacy-status manual leads
    // are lifted into the pipeline on claim, same as New_Unassigned.
    if (row.lead_status === "Converted" || row.lead_status === "Lost") {
        return { ok: false, reason: "terminal" };
    }

    const updated = await db.execute<{ id: string }>(sql`
        UPDATE dealer_leads
        SET current_owner_id = ${actorId},
            originator_id = COALESCE(originator_id, ${actorId}),
            assigned_at = NOW(),
            lead_status = 'Assigned_Not_Contacted',
            updated_at = NOW()
        WHERE id = ${leadId}
          AND current_owner_id IS NULL
          AND lead_status IS DISTINCT FROM 'Converted'
          AND lead_status IS DISTINCT FROM 'Lost'
        RETURNING id
    `);
    // Zero rows = someone else won between our SELECT and UPDATE.
    if (updated.length === 0) return { ok: false, reason: "already_owned" };

    await writeTouchpoint({
        dealerLeadId: leadId,
        touchpointType: "lead_claimed",
        performedBy: actorId,
        remarks: "Claimed from unassigned queue",
        // E-295: the guarded UPDATE guarantees the lead was unowned.
        fromOwnerId: null,
        toOwnerId: actorId,
        statusChange: {
            from: (row.lead_status as LeadStatus | null) ?? "New_Unassigned",
            to: "Assigned_Not_Contacted",
        },
    });

    return { ok: true };
}
