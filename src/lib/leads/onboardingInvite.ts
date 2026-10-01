// Invite a converted lead's dealer onto WhatsApp onboarding — the lead screen's
// "Invite on WhatsApp" action. Extracted from
// POST /api/inside-sales/lead/[id]/whatsapp-onboarding so the screen and the
// WhatsApp Assistant send it the same way. The session-linking + invite itself
// is the dealer bot's (lib/whatsapp/operator-handoff.ts); this is the CRM-side
// action around it: which application, which number.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { inviteDealerToApplication, type InviteResult } from "@/lib/whatsapp/operator-handoff";
import { toWaPhone } from "@/lib/whatsapp/operator-identity";

export type OnboardingInviteTarget = {
    applicationId: string;
    /** E.164 without '+'. */
    waPhone: string;
    dealerName: string | null;
};

export type PrepareInviteOutcome =
    | { ok: true; target: OnboardingInviteTarget }
    | { ok: false; reason: "not_found" | "no_application" | "no_phone" };

/** Who would be invited, or why nobody can be. Reads only. */
export async function prepareOnboardingInvite(leadId: string): Promise<PrepareInviteOutcome> {
    const [lead] = await db
        .select({
            phone: dealerLeads.phone,
            dealer_name: dealerLeads.dealer_name,
            application_id: dealerLeads.dealer_onboarding_application_id,
        })
        .from(dealerLeads)
        .where(sql`${dealerLeads.id} = ${leadId}`)
        .limit(1);
    if (!lead) return { ok: false, reason: "not_found" };
    if (!lead.application_id) return { ok: false, reason: "no_application" };
    // dealer_leads.phone is stored as 10 digits; WhatsApp wants E.164 without '+'.
    const waPhone = toWaPhone(lead.phone ?? "");
    if (!waPhone) return { ok: false, reason: "no_phone" };
    return { ok: true, target: { applicationId: lead.application_id, waPhone, dealerName: lead.dealer_name } };
}

/** Bind the dealer's session to the application and send the invite. */
export function sendOnboardingInvite(target: OnboardingInviteTarget): Promise<InviteResult> {
    return inviteDealerToApplication({
        applicationId: target.applicationId,
        dealerWaPhone: target.waPhone,
        dealerName: target.dealerName,
    });
}
