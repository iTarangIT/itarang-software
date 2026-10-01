// Raise an escalation on a lead (BRD §0.6). Extracted from
// POST /api/inside-sales/lead/[id]/escalate so the screen and the WhatsApp
// Assistant escalate exactly the same way. Owner remains unchanged; admin
// resolves (Module 3). escalation_status flips to 'pending_review'.
//
// ONE transaction: the lead_escalations row, the dealer_leads counters and the
// escalation_raised touchpoint. Notifications are NOT sent here — the result
// carries `notify`, which the caller runs after its transaction commits
// (best-effort, as the route always did).
//
// Ownership is the CALLER's job (assertOwner before calling).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadEscalations } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { OPEN_STATUSES, type LeadStatus } from "@/lib/lifecycle/transitions";
import { notifyRoles } from "@/lib/notifications/notify";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// BRD §0.6 reason pickers — what the EscalateModal offers each role.
export const IS_REP_ESCALATION_REASONS = [
    "Commercial_Decision_Needed",
    "Customer_Complaint",
    "Compliance_Concern",
    "Internal_Dispute",
    "Other",
] as const;

export const ASM_ESCALATION_REASONS = [
    "Not_Ready_for_Visit",
    "Dealer_Stalling",
    "Territory_Mismatch",
    "Customer_Complaint",
    "Internal_Dispute",
    "Compliance_Concern",
    "Other",
] as const;

export const ALL_ESCALATION_REASONS = [
    ...new Set([...IS_REP_ESCALATION_REASONS, ...ASM_ESCALATION_REASONS]),
] as [string, ...string[]];

export const ESCALATION_URGENCIES = ["normal", "high", "urgent"] as const;
export type EscalationUrgency = (typeof ESCALATION_URGENCIES)[number];

export const ESCALATION_NOTES_MIN = 30;

/** Roles notified for an escalation — admin + sales_head (+ partner) always, CEO on urgent. */
export function escalationNotifyRoles(urgency: EscalationUrgency): string[] {
    // `partner` runs the lead desk at sales_head scope and can open
    // /admin/escalations, so it is notified on the same terms.
    return urgency === "urgent"
        ? ["admin", "sales_head", "ceo", "partner"]
        : ["admin", "sales_head", "partner"];
}

export class EscalateError extends Error {
    constructor(
        readonly code: "not_found" | "not_open",
        message: string,
        readonly status: 400 | 404,
    ) {
        super(message);
    }
}

export type EscalateInput = {
    leadId: string;
    actor: { id: string; name: string };
    reason: string;
    notes: string;
    suggestedAction?: string | null;
    urgency: EscalationUrgency;
};

export type EscalateResult = {
    escalationId: string | null;
    /** Run AFTER the transaction commits. Never throws. */
    notify: () => Promise<void>;
};

export async function escalateLead(input: EscalateInput, opts?: { tx?: Tx }): Promise<EscalateResult> {
    const run = async (tx: Tx): Promise<string | null> => {
        const stateRows = await tx.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
        `);
        const status = stateRows[0]?.lead_status as LeadStatus | null;
        if (!status) throw new EscalateError("not_found", "Lead not found", 404);
        if (!OPEN_STATUSES.includes(status)) {
            throw new EscalateError("not_open", "Escalation requires an open lead status.", 400);
        }

        const inserted = await tx
            .insert(leadEscalations)
            .values({
                dealer_lead_id: input.leadId,
                raised_by: input.actor.id,
                raised_at: new Date(),
                escalation_reason: input.reason,
                escalation_notes: input.notes,
                suggested_action: input.suggestedAction ?? null,
                urgency: input.urgency,
                status: "pending_review",
            })
            .returning({ escalation_id: leadEscalations.escalation_id });
        const escalationId = inserted[0]?.escalation_id ?? null;

        await tx.execute(sql`
            UPDATE dealer_leads
            SET escalation_status = 'pending_review',
                escalation_count = COALESCE(escalation_count, 0) + 1,
                last_escalation_id = ${escalationId},
                updated_at = NOW()
            WHERE id = ${input.leadId}
        `);

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "escalation_raised",
                performedBy: input.actor.id,
                remarks: `[${input.urgency.toUpperCase()}] ${input.reason}\n\n${input.notes}${
                    input.suggestedAction ? `\n\nSuggested: ${input.suggestedAction}` : ""
                }`,
            },
            { tx },
        );
        return escalationId;
    };
    const escalationId = opts?.tx ? await run(opts.tx) : await db.transaction(run);

    // BRD §0.6 — in-app escalation alerts. A notification failure must never
    // break escalation creation.
    const notify = async () => {
        try {
            await notifyRoles(escalationNotifyRoles(input.urgency), {
                type: "escalation_raised",
                title: input.urgency === "urgent" ? "Urgent escalation raised" : "Escalation raised",
                message: `${input.reason.replace(/_/g, " ")} — raised by ${input.actor.name}`,
                data: { escalation_id: escalationId, lead_id: input.leadId },
                leadId: input.leadId,
            });
        } catch (err) {
            console.error("[escalate] notification failed:", err);
        }
    };
    return { escalationId, notify };
}
