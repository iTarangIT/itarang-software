// Correct GSTIN for a Won lead (tracker ID 124) — the writes. Rules and the
// reasoning are in correctLeadGstinRules.ts.
//
// ONE transaction, under withLeadActor (the E-304 audit trigger records the
// GSTIN edit against the actor): dealer_leads.gstin and the onboarding
// application's gst_number move together, a timeline note says old → new and
// why, and one audit_logs row carries the same. Not work: the idle clock does
// not move.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { auditLogs } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { withLeadActor } from "@/lib/leads/actorContext";
import {
    LeadGstinCorrectionError,
    canCorrectLeadGstin,
    planGstinCorrection,
} from "@/lib/leads/correctLeadGstinRules";

export { GSTIN_CORRECTION_MANAGER_ROLES, LeadGstinCorrectionError } from "@/lib/leads/correctLeadGstinRules";

export type CorrectLeadGstinResult = {
    from: string | null;
    to: string;
    /** The onboarding application updated with it, when the lead has one. */
    applicationId: string | null;
};

export async function correctLeadGstin(input: {
    leadId: string;
    actor: { id: string; role: string };
    gstin: string;
    reason: string;
}): Promise<CorrectLeadGstinResult> {
    return withLeadActor(input.actor.id, async (tx) => {
        const rows = (await tx.execute<{
            lead_status: string | null;
            gstin: string | null;
            current_owner_id: string | null;
        }>(sql`
            SELECT lead_status, gstin, current_owner_id FROM dealer_leads
             WHERE id = ${input.leadId}
             FOR UPDATE
        `)) as unknown as Array<{ lead_status: string | null; gstin: string | null; current_owner_id: string | null }>;
        const lead = rows[0];
        if (!lead) throw new LeadGstinCorrectionError("Lead not found", 404);
        if (!canCorrectLeadGstin({ role: input.actor.role, userId: input.actor.id, ownerId: lead.current_owner_id })) {
            throw new LeadGstinCorrectionError("Only the lead's owner, the Sales Head or admin can correct its GSTIN.", 403);
        }

        const plan = planGstinCorrection({
            leadStatus: lead.lead_status,
            currentGstin: lead.gstin,
            newGstin: input.gstin,
            reason: input.reason,
        });

        await tx.execute(sql`
            UPDATE dealer_leads SET gstin = ${plan.to}, updated_at = NOW() WHERE id = ${input.leadId}
        `);
        const apps = (await tx.execute<{ id: string; gst_number: string | null }>(sql`
            UPDATE dealer_onboarding_applications a
               SET gst_number = ${plan.to}, updated_at = NOW()
              FROM (SELECT id, gst_number FROM dealer_onboarding_applications
                     WHERE originating_dealer_lead_id = ${input.leadId} FOR UPDATE) prev
             WHERE a.id = prev.id
            RETURNING a.id::text AS id, prev.gst_number AS gst_number
        `)) as unknown as Array<{ id: string; gst_number: string | null }>;
        const applicationId = apps[0]?.id ?? null;

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "status_change_note",
                performedBy: input.actor.id,
                remarks: `GSTIN corrected: ${plan.from ?? "none"} → ${plan.to}${
                    applicationId ? " (lead and onboarding application)" : ""
                } — ${plan.reason}`,
                countsAsWork: false,
            },
            { tx },
        );
        await tx.insert(auditLogs).values({
            id: randomUUID(),
            entity_type: "dealer_lead",
            entity_id: input.leadId,
            action: "lead_gstin_corrected",
            performed_by: input.actor.id,
            old_data: { gstin: plan.from, application_gst_number: apps[0]?.gst_number ?? null },
            new_data: { gstin: plan.to, onboarding_application_id: applicationId, reason: plan.reason },
            timestamp: new Date(),
        });

        return { from: plan.from, to: plan.to, applicationId };
    });
}
