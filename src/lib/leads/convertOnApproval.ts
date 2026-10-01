// Converted = the dealer's onboarding was APPROVED (tracker ID 74, handover
// P2-1, 29 Sep 2026). The rep's Mark Won sets Won; this sets Converted when an
// admin approves the onboarding application that came from the lead. Credit,
// targets and incentives run on Converted, and the closing owner recorded at
// Won is kept (writeTouchpoint).
//
// Best-effort and post-commit: approval must never fail because the lead could
// not be moved. A lead already Converted, or with no link, is left alone.
//
// ID 84.4: only the application the lead currently points at
// (dealer_leads.dealer_onboarding_application_id) converts it. A lead
// re-engaged after a drop-out has that link cleared, so approving the OLD
// application cannot convert the reopened lead.
//
// ID 74.7: when a linked lead is NOT converted — the guard refused or the write
// failed — admins and sales heads are told and the lead's timeline records it
// (a system note that never counts as work), instead of a console line nobody
// reads.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { checkStatusMove } from "@/lib/lifecycle/statusRules";
import { notifyRoles } from "@/lib/notifications/notify";

type LinkedLead = {
    id: string;
    lead_status: string | null;
    linked_application_id: string | null;
};

/** Tell admin + sales_head, and leave a system note on the lead. Never throws. */
async function reportNotConverted(leadId: string, applicationId: string, why: string): Promise<void> {
    try {
        await writeTouchpoint({
            dealerLeadId: leadId,
            touchpointType: "status_change_note",
            performedBy: null,
            syncMethod: "system",
            remarks: `Dealer onboarding approved, but the lead was NOT moved to Converted: ${why}`,
            countsAsWork: false,
        });
    } catch (err) {
        console.error("[convertOnApproval] audit note failed", leadId, err);
    }
    try {
        await notifyRoles(["admin", "sales_head"], {
            type: "lead_conversion_failed",
            title: "Onboarding approved — lead not Converted",
            message: `The dealer's onboarding was approved, but its lead was not moved to Converted: ${why} Check the lead and correct its status if needed.`,
            leadId,
            data: { onboarding_application_id: applicationId },
        });
    } catch (err) {
        console.error("[convertOnApproval] notification failed", leadId, err);
    }
}

export async function convertLeadOnOnboardingApproval(
    applicationId: string,
    actorId: string | null,
): Promise<{ leadId: string | null; converted: boolean }> {
    let lead: LinkedLead | undefined;
    try {
        const rows = (await db.execute<LinkedLead>(sql`
            SELECT dl.id, dl.lead_status,
                   dl.dealer_onboarding_application_id::text AS linked_application_id
              FROM dealer_leads dl
              LEFT JOIN dealer_onboarding_applications oa ON oa.id::text = ${applicationId}
             WHERE dl.dealer_onboarding_application_id::text = ${applicationId}
                OR dl.id = oa.originating_dealer_lead_id
             ORDER BY (dl.dealer_onboarding_application_id::text = ${applicationId}) DESC NULLS LAST
             LIMIT 1
        `)) as unknown as LinkedLead[];
        lead = rows[0];
        if (!lead) return { leadId: null, converted: false };

        // ID 84.4: the lead must still point at THIS application.
        if (lead.linked_application_id !== applicationId) {
            await reportNotConverted(
                lead.id,
                applicationId,
                lead.linked_application_id
                    ? "the lead now points at a different onboarding application."
                    : "the lead is no longer linked to this application (re-engaged after a drop-out?).",
            );
            return { leadId: lead.id, converted: false };
        }

        const verdict = checkStatusMove({ from: lead.lead_status, to: "Converted", event: "onboarding_approved" });
        // Already Converted (an approval run twice): nothing to do, nothing to report.
        if (verdict.ok && verdict.noop) return { leadId: lead.id, converted: false };
        if (!verdict.ok) {
            await reportNotConverted(lead.id, applicationId, verdict.reason);
            return { leadId: lead.id, converted: false };
        }
        await writeTouchpoint({
            dealerLeadId: lead.id,
            touchpointType: "status_change_note",
            performedBy: actorId,
            remarks: "Dealer onboarding approved — lead Converted.",
            // ID 115.5: the admin's approval is not the owner working the lead.
            countsAsWork: false,
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
        if (lead) {
            await reportNotConverted(
                lead.id,
                applicationId,
                `the status write failed (${err instanceof Error ? err.message : String(err)}).`,
            );
        }
        return { leadId: lead?.id ?? null, converted: false };
    }
}
