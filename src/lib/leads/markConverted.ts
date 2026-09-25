// Mark a lead Converted (BRD §0.7 / §0.13). Extracted from
// POST /api/inside-sales/lead/[id]/mark-converted so the screen and the
// WhatsApp Assistant convert exactly the same way.
//
// Terminal Converted, settable from any status. Conversion and onboarding
// creation commit or roll back together (BRD §0.13 Point A): a lead is never
// left Converted without an application. Re-converting is safe — the
// application is created ON CONFLICT DO NOTHING, keyed on the lead.
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

export async function markLeadConverted(
    input: MarkConvertedInput,
    opts?: { tx?: Tx },
): Promise<MarkConvertedResult> {
    const { leadId, actor } = input;
    const run = async (tx: Tx): Promise<string> => {
        const rows = await tx.execute<{ lead_status: string | null; asm_id: string | null }>(sql`
            SELECT dl.lead_status, dl.asm_id FROM dealer_leads dl WHERE dl.id = ${leadId} LIMIT 1
        `);
        const state = rows[0];
        if (!state) throw new ConvertLeadNotFoundError();
        const fromStatus = state.lead_status as LeadStatus | null;

        const closingRole = deriveConvertClosingRole(actor.role, state.asm_id);
        const remarks = input.notes?.trim() || "Lead marked as Converted. Dealer onboarding initiated.";

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
                    to: "Converted",
                    reasonNotes: input.notes ?? null,
                    closingRole,
                },
            },
            { tx },
        );

        const { applicationId } = await createOnboardingApplicationForConvertedLead(leadId, tx);
        if (!applicationId) {
            throw new Error("Failed to create dealer onboarding application");
        }

        // Pre-fill the onboarding form's GST number so the dealer is not asked
        // again. Never overwrites a number the application already carries.
        await tx.execute(sql`
            UPDATE dealer_onboarding_applications
               SET gst_number = ${input.gstin}
             WHERE id = ${applicationId}::uuid
               AND NULLIF(btrim(gst_number), '') IS NULL
        `);

        // BRD §0.13 audit — record the onboarding initiation event.
        await tx.insert(auditLogs).values({
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
        try {
            await notifyUser(actor.id, {
                type: "onboarding_initiated",
                title: "Dealer onboarding initiated",
                message: "Lead converted — a draft dealer onboarding application was created.",
                leadId,
                data: { onboarding_application_id: applicationId },
            });
            await notifyRoles(["admin", "sales_head", "partner"], {
                type: "onboarding_initiated",
                title: "New dealer onboarding application created",
                message: `${actor.name} converted a lead — onboarding application created.`,
                leadId,
                data: { onboarding_application_id: applicationId },
            });
        } catch (err) {
            console.error("[mark-converted] notification failed:", err);
        }
    };
    return { applicationId, notify };
}
