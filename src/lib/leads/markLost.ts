// Mark a lead Lost (BRD §0.7) — terminal, with a mandatory reason. Extracted
// from POST /api/inside-sales/lead/[id]/mark-lost so the screen and the
// WhatsApp Assistant close a lead exactly the same way.
//
// ONE transaction: the business_closed side effect (permanently exclude from
// the AI dialer) and the Lost touchpoint + status history commit together. (The
// route used to set ai_recall_status in its own statement first.)
//
// Ownership is the CALLER's job (assertOwner before calling).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isHighImpactLostReason, type LeadStatus, type LostReason } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// BRD §0.13 closing_role audit:
//   is_phone        — IS rep closed via phone workflow
//   asm_visit       — ASM closed via ground visit
//   is_post_handoff — IS rep got the lead back after handoff (admin reassign)
//   admin / system  — reserved for admin loopback + automated paths
export function deriveClosingRole(role: string): "is_phone" | "asm_visit" | "admin" {
    if (role === "asm") return "asm_visit";
    if (role === "admin") return "admin";
    return "is_phone";
}

export class LostNotesRequiredError extends Error {
    constructor() {
        super("lost_reason_notes is required when lost_reason = 'other'.");
    }
}

export class HighImpactUnconfirmedError extends Error {
    constructor() {
        super("High-impact lost reason requires explicit confirmation.");
    }
}

/** ID 76: "Lost to competition" names the competitor. */
export class CompetitorRequiredError extends Error {
    constructor() {
        super("Name the competitor when the reason is 'Lost to competition'.");
    }
}

export class LostLeadNotFoundError extends Error {
    constructor() {
        super("Lead not found");
    }
}

export type MarkLostInput = {
    leadId: string;
    actor: { id: string; role: string };
    reason: LostReason;
    notes?: string | null;
    /** Required true for the four high-impact reasons (the UI's consequence modal). */
    confirmedHighImpact?: boolean;
    /** Required for lost_to_competition (ID 76); stored in dealer_leads.competitor_name (E-314). */
    competitorName?: string | null;
    /** Who closed it, when the actor's role does not say — the admin bulk action is always "admin". */
    closingRole?: "is_phone" | "asm_visit" | "admin";
    /**
     * ID 115.4: Won → Lost is refused unless admin-driven. Only the admin
     * onboarding drop-out resolution passes it.
     */
    adminOverride?: boolean;
};

/** The same refusals the route has always made, before anything is written. */
export function checkMarkLost(
    input: Pick<MarkLostInput, "reason" | "notes" | "confirmedHighImpact" | "competitorName">,
): void {
    if (input.reason === "other" && !input.notes?.trim()) throw new LostNotesRequiredError();
    if (input.reason === "lost_to_competition" && !input.competitorName?.trim()) throw new CompetitorRequiredError();
    if (isHighImpactLostReason(input.reason) && !input.confirmedHighImpact) throw new HighImpactUnconfirmedError();
}

export async function markLeadLost(input: MarkLostInput, opts?: { tx?: Tx }): Promise<void> {
    checkMarkLost(input);
    const run = async (tx: Tx) => {
        const stateRows = await tx.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1 FOR UPDATE
        `);
        if (stateRows.length === 0) throw new LostLeadNotFoundError();
        // Reachable from any OPEN status before Won, and a lead with no status.
        // Won → Lost needs adminOverride; a Converted lead goes to Lost only
        // through the admin drop-out resolution (S3, statusRules.ts).
        const fromStatus = stateRows[0]?.lead_status as LeadStatus | null;
        // ID 115.6: a second Mark Lost racing the first is a no-op — nothing to
        // write, and the first one's reason / competitor are not overwritten.
        if (fromStatus === "Lost") return;

        // ID 76: the competitor's name (E-314 column, raw — only this reason writes it).
        if (input.reason === "lost_to_competition") {
            await tx.execute(sql`
                UPDATE dealer_leads SET competitor_name = ${input.competitorName!.trim()} WHERE id = ${input.leadId}
            `);
        }

        // BRD §0.7 side effect: business_closed permanently excludes from AI dialer.
        if (input.reason === "business_closed") {
            await tx.execute(sql`
                UPDATE dealer_leads SET ai_recall_status = 'excluded', updated_at = NOW() WHERE id = ${input.leadId}
            `);
        }

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "status_change_note",
                performedBy: input.actor.id,
                remarks: input.notes ?? `Marked Lost — ${input.reason}`,
                statusChange: {
                    from: fromStatus,
                    to: "Lost",
                    toLostReason: input.reason,
                    reasonNotes: input.notes ?? null,
                    closingRole: input.closingRole ?? deriveClosingRole(input.actor.role),
                    event: "mark_lost",
                    adminOverride: input.adminOverride,
                },
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
