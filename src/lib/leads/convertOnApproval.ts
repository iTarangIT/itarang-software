// Converted = the dealer's onboarding was APPROVED (tracker ID 74, handover
// P2-1, 29 Sep 2026). The rep's Mark Won sets Won; this sets Converted when an
// admin approves the onboarding application that came from the lead. Credit,
// targets and incentives run on Converted, and the closing owner recorded at
// Won is kept (writeTouchpoint).
//
// Best-effort and post-commit: approval must never fail because the lead could
// not be moved. A lead already Converted, Lost, or with no link is left alone.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { checkStatusMove } from "@/lib/lifecycle/statusRules";

export async function convertLeadOnOnboardingApproval(
    applicationId: string,
    actorId: string | null,
): Promise<{ leadId: string | null; converted: boolean }> {
    try {
        const rows = (await db.execute<{ id: string; lead_status: string | null }>(sql`
            SELECT dl.id, dl.lead_status
              FROM dealer_leads dl
              LEFT JOIN dealer_onboarding_applications oa ON oa.id::text = ${applicationId}
             WHERE dl.dealer_onboarding_application_id::text = ${applicationId}
                OR dl.id = oa.originating_dealer_lead_id
             LIMIT 1
        `)) as unknown as Array<{ id: string; lead_status: string | null }>;
        const lead = rows[0];
        if (!lead) return { leadId: null, converted: false };
        if (!checkStatusMove({ from: lead.lead_status, to: "Converted", event: "onboarding_approved" }).ok) {
            return { leadId: lead.id, converted: false };
        }
        await writeTouchpoint({
            dealerLeadId: lead.id,
            touchpointType: "status_change_note",
            performedBy: actorId,
            remarks: "Dealer onboarding approved — lead Converted.",
            statusChange: {
                from: lead.lead_status as never,
                to: "Converted",
                closingRole: "admin",
                event: "onboarding_approved",
            },
        });
        return { leadId: lead.id, converted: true };
    } catch (err) {
        console.error("[convertOnApproval] could not convert lead for application", applicationId, err);
        return { leadId: null, converted: false };
    }
}
