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
};

/** The same refusals the route has always made, before anything is written. */
export function checkMarkLost(input: Pick<MarkLostInput, "reason" | "notes" | "confirmedHighImpact">): void {
    if (input.reason === "other" && !input.notes?.trim()) throw new LostNotesRequiredError();
    if (isHighImpactLostReason(input.reason) && !input.confirmedHighImpact) throw new HighImpactUnconfirmedError();
}

export async function markLeadLost(input: MarkLostInput, opts?: { tx?: Tx }): Promise<void> {
    checkMarkLost(input);
    const run = async (tx: Tx) => {
        const stateRows = await tx.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
        `);
        if (stateRows.length === 0) throw new LostLeadNotFoundError();
        // Reachable from ANY status, for any role — a Converted lead (the
        // onboarding-dropout loopback, no longer admin-only) and a lead with no
        // status included. The reason itself is still mandatory.
        const fromStatus = stateRows[0]?.lead_status as LeadStatus | null;

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
                    closingRole: deriveClosingRole(input.actor.role),
                },
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
