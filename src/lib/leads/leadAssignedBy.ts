// "Who handed this lead to its current owner?" — for the admin Leads list.
//
// WHY THE TIMELINE AND NOT A COLUMN. `dealer_leads` records WHO OWNS a lead
// (current_owner_id) and WHEN it changed hands (assigned_at), but never who did
// the handing. That fact only exists as the actor on the audit touchpoint every
// assignment path already writes — see assignLeadOwner(), which stamps
// performedBy: actorId on all four of its branches, and the NeoDove push, which
// routes through the same function.
//
// Reading the timeline instead of adding a column means this also works
// RETROACTIVELY: every assignment ever made is already recorded, so the stamp
// appears on historical leads rather than only on ones assigned from today. A
// new column would need a migration plus a backfill that would have to read
// these same rows anyway.
//
// ⚠ ASSIGNMENT TYPES ONLY. `lead_claimed` is deliberately excluded: a rep taking
// a lead from the Unassigned queue was not SENT it by anyone, and rendering
// "sent by Nidhi" on Nidhi's own lead states the opposite of what happened. The
// self-assignment guard in the API is the second half of that same rule.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/** The three touchpoint types assignLeadOwner can write. */
const ASSIGNMENT_TOUCHPOINTS = [
    "lead_assigned",
    "ownership_transfer",
    "asm_transfer",
] as const;

export type LeadAssignedBy = {
    id: string;
    name: string | null;
    /** The SENDER's role — ceo, admin, sales_head… — not the recipient's. */
    role: string | null;
    /** When the hand-off happened. */
    at: string | null;
};

type Row = {
    id: string;
    actor_id: string;
    name: string | null;
    role: string | null;
    at: string | null;
};

/**
 * Latest assignment actor per lead, keyed by lead id. Never throws.
 *
 * Decoration over the current page's ids, like fetchCampaignForLeads — this is
 * a per-page lookup, not something to join into the main list query.
 */
export async function fetchAssignedByForLeads(
    leadIds: string[],
): Promise<Record<string, LeadAssignedBy>> {
    const out: Record<string, LeadAssignedBy> = {};
    if (!leadIds.length) return out;

    // IN (…), never `= ANY(${array})` — drizzle expands a JS array into a row
    // constructor and the statement fails at the database.
    const idList = sql.join(
        leadIds.map((id) => sql`${id}`),
        sql`, `,
    );
    const types = sql.join(
        ASSIGNMENT_TOUCHPOINTS.map((t) => sql`${t}`),
        sql`, `,
    );

    try {
        const rows = await db.execute<Row>(sql`
            SELECT DISTINCT ON (lt.dealer_lead_id)
                   lt.dealer_lead_id AS id,
                   lt.performed_by   AS actor_id,
                   u.name            AS name,
                   u.role            AS role,
                   lt.performed_at   AS at
              FROM lead_touchpoints lt
              JOIN users u ON u.id::text = lt.performed_by
             WHERE lt.dealer_lead_id IN (${idList})
               AND lt.touchpoint_type IN (${types})
             ORDER BY lt.dealer_lead_id, lt.performed_at DESC
        `);
        for (const r of rows as unknown as Row[]) {
            out[r.id] = {
                id: r.actor_id,
                name: r.name,
                role: r.role,
                at: r.at,
            };
        }
    } catch {
        // Degrade to no stamp rather than taking the list down.
    }

    return out;
}
