// Mark a lead WON (tracker ID 74, 29 Sep 2026; was "Mark Converted", BRD
// §0.7 / §0.13). Extracted from POST /api/inside-sales/lead/[id]/mark-converted
// so the screen and the WhatsApp Assistant do it exactly the same way — the
// route and function keep their old names.
//
// The rep's action sets Won and records the closing owner; Converted is set
// only when the admin approves the dealer's onboarding (markLeadConvertedOnApproval),
// and conversion credit, targets and incentives run on Converted. Won and
// onboarding creation commit or roll back together (BRD §0.13 Point A): a lead
// is never left Won without an application. Re-running is safe — the
// application is created ON CONFLICT DO NOTHING, keyed on the lead.
//
// Won is allowed before a dealer-approved quote and FLAGGED
// (won_without_approved_quote, E-314) — decision still open with business.
//
// Without `tx` it runs inside withLeadActor (the E-304 audit trigger records the
// GSTIN edit against the actor). With `tx`, the caller must already have set
// app.actor_id on it (the Assistant executor does).
//
// Notifications are NOT sent here — the result carries `notify`, to run after
// the transaction commits (best-effort, as the route always did).
//
// Ownership is the CALLER's job (assertOwner before calling).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { type LeadStatus } from "@/lib/lifecycle/transitions";
import { createOnboardingApplicationForConvertedLead } from "@/lib/onboarding/fromConvertedLead";
import { notifyRoles, notifyUser } from "@/lib/notifications/notify";
import { withLeadActor } from "@/lib/leads/actorContext";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// BRD §0.13 closing_role audit — derived from actor role + lead history. An
// Inside Sales rep closing a lead that passed through an ASM (asm_id set, then
// reassigned back) is a post-handoff close; a direct phone close otherwise.
export function deriveConvertClosingRole(
    role: string,
    asmId: string | null,
): "is_phone" | "asm_visit" | "is_post_handoff" | "admin" {
    if (role === "asm") return "asm_visit";
    if (role === "admin") return "admin";
    return asmId ? "is_post_handoff" : "is_phone";
}

export class ConvertLeadNotFoundError extends Error {
    constructor() {
        super("Lead not found");
    }
}

export type MarkConvertedInput = {
    leadId: string;
    actor: { id: string; name: string; role: string };
    /** Already normalised + validated (isValidGstin). */
    gstin: string;
    notes?: string | null;
};

export type MarkConvertedResult = {
    applicationId: string;
    /** Run AFTER the transaction commits. Never throws. */
    notify: () => Promise<void>;
};

/**
 * What a won lead carries besides its status: the won-without-quote flag and
 * its onboarding application, GST number pre-filled. Run AFTER the status is
 * written (the application copies the closing owner). Shared with admin
 * "Correct status" (ID 57), so a lead corrected to Won / Converted is never
 * left without an application. Idempotent — an existing application is reused.
 */
export async function attachOnboardingToWonLead(
    tx: Tx,
    leadId: string,
    gstin: string,
): Promise<{ applicationId: string; created: boolean }> {
    // ID 74: flag a Won with no dealer-approved, not-withdrawn quote.
    await tx.execute(sql`
        UPDATE dealer_leads
           SET won_without_approved_quote = NOT EXISTS (
                 SELECT 1 FROM dealer_lead_commercials c
                  WHERE c.dealer_lead_id = ${leadId}
                    AND c.event_type IN ('quote_issue', 'quote_revision')
                    AND c.dealer_decision = 'approved'
                    AND c.withdrawn_at IS NULL)
         WHERE id = ${leadId}
    `);

    const { applicationId, created } = await createOnboardingApplicationForConvertedLead(leadId, tx);
    if (!applicationId) {
        throw new Error("Failed to create dealer onboarding application");
    }

    // Pre-fill the onboarding form's GST number so the dealer is not asked
    // again. Never overwrites a number the application already carries.
    await tx.execute(sql`
        UPDATE dealer_onboarding_applications
           SET gst_number = ${gstin}
         WHERE id = ${applicationId}::uuid
           AND NULLIF(btrim(gst_number), '') IS NULL
    `);

    return { applicationId, created };
}

export async function markLeadConverted(
    input: MarkConvertedInput,
    opts?: { tx?: Tx },
): Promise<MarkConvertedResult> {
    const { leadId, actor } = input;
    // ID 115.6: a second Mark Won (double tap, two reps) is a no-op move; it
    // must not log a second "onboarding initiated" or notify twice.
    let repeat = false;
    const run = async (tx: Tx): Promise<string> => {
        const rows = await tx.execute<{ lead_status: string | null; asm_id: string | null }>(sql`
            SELECT dl.lead_status, dl.asm_id FROM dealer_leads dl WHERE dl.id = ${leadId} LIMIT 1
        `);
        const state = rows[0];
        if (!state) throw new ConvertLeadNotFoundError();
        const fromStatus = state.lead_status as LeadStatus | null;
        repeat = fromStatus === "Won";

        const closingRole = deriveConvertClosingRole(actor.role, state.asm_id);
        const remarks = input.notes?.trim() || "Lead marked Won. Dealer onboarding initiated.";

        await tx.execute(sql`
            UPDATE dealer_leads SET gstin = ${input.gstin} WHERE id = ${leadId}
        `);

        await writeTouchpoint(
            {
                dealerLeadId: leadId,
                touchpointType: "status_change_note",
                performedBy: actor.id,
                remarks,
                statusChange: {
                    from: fromStatus,
                    to: "Won",
                    reasonNotes: input.notes ?? null,
                    closingRole,
                    event: "mark_won",
                },
            },
            { tx },
        );

        const { applicationId } = await attachOnboardingToWonLead(tx, leadId, input.gstin);

        // BRD §0.13 audit — record the onboarding initiation event (once).
        if (!repeat) await tx.insert(auditLogs).values({
            id: randomUUID(),
            entity_type: "dealer_lead",
            entity_id: leadId,
            action: "onboarding_initiated",
            performed_by: actor.id,
            new_data: { onboarding_application_id: applicationId },
            timestamp: new Date(),
        });

        return applicationId;
    };
    const applicationId = opts?.tx ? await run(opts.tx) : await withLeadActor(actor.id, run);

    // BRD §0.13 Step 7 — notify the closing owner + admins.
    const notify = async () => {
        if (repeat) return;
        try {
            await notifyUser(actor.id, {
                type: "onboarding_initiated",
                title: "Dealer onboarding initiated",
                message: "Lead marked Won — a draft dealer onboarding application was created. It becomes Converted when the onboarding is approved.",
                leadId,
                data: { onboarding_application_id: applicationId },
            });
            await notifyRoles(["admin", "sales_head", "partner"], {
                type: "onboarding_initiated",
                title: "New dealer onboarding application created",
                message: `${actor.name} marked a lead Won — onboarding application created.`,
                leadId,
                data: { onboarding_application_id: applicationId },
            });
        } catch (err) {
            console.error("[mark-converted] notification failed:", err);
        }
    };
    return { applicationId, notify };
}
