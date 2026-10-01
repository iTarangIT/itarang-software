// Set a lead's interest level (hot/warm/cold) — BRD §0.7. Extracted from PATCH
// /api/inside-sales/lead/[id]/interest-level so the WhatsApp Assistant's
// log_visit / log_call change interest exactly as the screen does: one
// dealer_leads update plus one interest_level_overrides audit row (E-123),
// with the acting user named for the E-304 audit trigger.
//
// Ownership is the CALLER's job (assertOwner before calling).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads, interestLevelOverrides } from "@/lib/db/schema";
import type { InterestLevel } from "@/lib/admin/salesDashboardTypes";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SetInterestLevelInput = {
    leadId: string;
    actorId: string;
    level: InterestLevel;
    /** Optional from the UI; the audit row's NOT NULL reason gets a default. */
    reason?: string | null;
};

/**
 * Returns null when the lead does not exist, `{ changed: false }` when it is
 * already at this level (no audit row), `{ changed: true }` otherwise.
 */
export async function setInterestLevel(
    input: SetInterestLevelInput,
    opts?: { tx?: Tx },
): Promise<{ changed: boolean } | null> {
    const run = async (tx: Tx) => {
        const existing = await tx
            .select({ interest_level: dealerLeads.interest_level })
            .from(dealerLeads)
            .where(sql`${dealerLeads.id} = ${input.leadId}`)
            .limit(1);
        if (existing.length === 0) return null;

        const fromValue = existing[0].interest_level;
        if (fromValue === input.level) return { changed: false };

        const now = new Date();
        // E-304 — the audit trigger records this change in the interest
        // history; this names who made it (local to the transaction).
        await tx.execute(sql`SELECT set_config('app.actor_id', ${input.actorId}, true)`);
        await tx
            .update(dealerLeads)
            .set({ interest_level: input.level, updated_at: now })
            .where(sql`${dealerLeads.id} = ${input.leadId}`);

        await tx.insert(interestLevelOverrides).values({
            dealer_lead_id: input.leadId,
            from_value: fromValue ?? null,
            to_value: input.level,
            reason: input.reason?.trim() || "Manual temperature change",
            changed_by: input.actorId,
            changed_at: now,
        });
        return { changed: true };
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
