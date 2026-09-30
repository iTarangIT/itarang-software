// Claim a lead from the New_Unassigned queue (BRD §0.3 Path B).
//
// ONE implementation for the single-lead route and the bulk-claim route, so
// the two can never drift in what counts as "claimable" or in the touchpoint
// they leave behind.
//
// Atomic: the ownership UPDATE and its lead_claimed touchpoint commit or roll
// back together (they used to be two transactions, so a failed touchpoint left
// an owned lead with no audit row).
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
import { isForward } from "@/lib/lifecycle/statusRules";
import { OUTSIDE_TERRITORY_MARKER } from "@/lib/leads/claimScope";
import { markSalesReady } from "@/lib/leads/salesReady";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

// Role list + cap are defined in types.ts (client-safe); re-exported here so
// server callers have one import.
export { BULK_CLAIM_CAP, CLAIM_ROLES } from "@/lib/inside-sales/types";

export type ClaimSkipReason = "not_found" | "already_owned" | "terminal";

export type ClaimOutcome =
    | { ok: true }
    | { ok: false; reason: ClaimSkipReason };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function claimLead(
    leadId: string,
    actorId: string,
    opts?: {
        /** Fold the claim into a larger transaction (the WhatsApp Assistant). */
        tx?: Tx;
        /** The claimer's role. An ASM claim also makes them the lead's field ASM. */
        actorRole?: string;
    },
): Promise<ClaimOutcome> {
    // An ASM who claims a lead is its field ASM from now on. Today's Schedule
    // keys on dealer_leads.asm_id, not current_owner_id, so without this every
    // visit an ASM scheduled on a lead they CLAIMED (rather than were
    // transferred) never appeared there. Overwrites rather than COALESCEs: an
    // unowned lead can still carry the asm_id of an ASM who released it.
    const asmAssignment =
        opts?.actorRole === "asm" ? sql`, asm_id = ${actorId}` : sql``;

    const run = async (tx: Tx): Promise<ClaimOutcome> => {
        const rows = await tx.execute<{
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

        const updated = await tx.execute<{ id: string }>(sql`
            UPDATE dealer_leads
            SET current_owner_id = ${actorId},
                originator_id = COALESCE(originator_id, ${actorId}),
                assigned_at = NOW(),
                updated_at = NOW()
                ${asmAssignment}
            WHERE id = ${leadId}
              AND current_owner_id IS NULL
              AND lead_status IS DISTINCT FROM 'Converted'
              AND lead_status IS DISTINCT FROM 'Lost'
            RETURNING id
        `);
        // Zero rows = someone else won between our SELECT and UPDATE.
        if (updated.length === 0) return { ok: false, reason: "already_owned" };

        // ID 45: an ASM may claim in any territory; a claim outside their own
        // is marked on the touchpoint so the Sales Head sees it.
        let outsideTerritory = false;
        if (opts?.actorRole === "asm") {
            const inTerritory = await tx.execute<{ ok: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1 FROM dealer_leads dl
                      JOIN asm_territories t ON t.asm_id = ${actorId}
                                            AND t.state = dl.state
                                            AND (t.city IS NULL OR t.city = dl.city)
                                            AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                                            AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
                     WHERE dl.id = ${leadId}
                ) AS ok
            `);
            outsideTerritory = !inTerritory[0]?.ok;
        }

        await writeTouchpoint(
            {
                dealerLeadId: leadId,
                touchpointType: "lead_claimed",
                performedBy: actorId,
                remarks: outsideTerritory
                    ? `Claimed ${OUTSIDE_TERRITORY_MARKER}`
                    : "Claimed from unassigned queue",
                // E-295: the guarded UPDATE guarantees the lead was unowned.
                fromOwnerId: null,
                toOwnerId: actorId,
                // S3: the claim lifts a New / unstatused lead to Assigned; a lead
                // released after it was worked keeps its stage (never backwards).
                statusChange: isForward(row.lead_status, "Assigned_Not_Contacted")
                    ? {
                          from: (row.lead_status as LeadStatus | null) ?? "New_Unassigned",
                          to: "Assigned_Not_Contacted",
                      }
                    : undefined,
            },
            { tx },
        );

        // ID 82: a claim is a Sales-ready event (first one wins).
        await markSalesReady(tx, { leadId, reason: "claimed_by_rep", actorId });

        return { ok: true };
    };

    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
