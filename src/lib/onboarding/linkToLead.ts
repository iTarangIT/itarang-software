/**
 * Tracker ID 67 / handover P1-4 — link every dealer onboarding to its lead.
 *
 * Before this, only Mark Converted (fromConvertedLead.ts) linked an onboarding
 * to a lead. WhatsApp, operator, self-service and web-wizard onboardings stayed
 * orphaned, so the approved dealer's invoices matched no lead ("not on any CRM
 * lead" — Ayansh Engineering, ITD/202627/025).
 *
 * The match is BY PHONE, through the shared duplicate check
 * (leadSource.findExistingLeadByPhone → dedupe.loadExistingByPhone, last-10-
 * digit match), trying the owner's, the WhatsApp and the contact number in
 * that order. Where no lead has any of them, the onboarding is a DIRECT
 * onboarding: it stays unlinked and is counted as such on the account
 * (account_ownership.came_through = 'direct').
 *
 * Writes only what is empty and never steals:
 *   * dealer_onboarding_applications.originating_dealer_lead_id — only when
 *     NULL and no other application already holds that lead (the column has a
 *     partial UNIQUE index, E-127);
 *   * dealer_leads.dealer_onboarding_application_id — only when NULL.
 *
 * Never throws: an onboarding must not fail because the link could not be
 * made. Returns what it found.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { findExistingLeadByPhone } from "@/lib/leads/leadSource";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LeadLinkResult {
    /** The lead this onboarding belongs to (already linked or newly linked). */
    leadId: string | null;
    /** True when this call wrote a link. */
    linked: boolean;
    /** Which phone matched. */
    via: "existing" | "owner_phone" | "wa_phone" | "contact_phone" | null;
}

/** Pure: the phones to try, in order, de-duplicated. Exported for tests. */
export function candidatePhones(app: {
    owner_phone?: string | null;
    wa_phone?: string | null;
    contact_phone?: string | null;
}): Array<{ via: "owner_phone" | "wa_phone" | "contact_phone"; phone: string }> {
    const out: Array<{ via: "owner_phone" | "wa_phone" | "contact_phone"; phone: string }> = [];
    const seen = new Set<string>();
    for (const via of ["owner_phone", "wa_phone", "contact_phone"] as const) {
        const raw = app[via];
        const digits = (raw ?? "").replace(/\D/g, "").slice(-10);
        // Masked numbers ("98XXXXXX12") and short junk never match anything.
        if (digits.length !== 10 || seen.has(digits)) continue;
        seen.add(digits);
        out.push({ via, phone: raw as string });
    }
    return out;
}

export async function linkOnboardingToLead(
    applicationId: string,
    tx?: Tx,
): Promise<LeadLinkResult> {
    const none: LeadLinkResult = { leadId: null, linked: false, via: null };
    try {
        const runner = tx ?? db;
        const apps = (await runner.execute(sql`
            SELECT app.id, app.owner_phone, app.wa_phone, app.contact_phone,
                   app.originating_dealer_lead_id,
                   (SELECT dl.id FROM dealer_leads dl
                     WHERE dl.dealer_onboarding_application_id = app.id
                     ORDER BY dl.created_at ASC LIMIT 1) AS back_ref_lead_id
              FROM dealer_onboarding_applications app
             WHERE app.id = ${applicationId}
        `)) as unknown as Array<{
            id: string;
            owner_phone: string | null;
            wa_phone: string | null;
            contact_phone: string | null;
            originating_dealer_lead_id: string | null;
            back_ref_lead_id: string | null;
        }>;
        const app = apps[0];
        if (!app) return none;
        const existing = app.originating_dealer_lead_id ?? app.back_ref_lead_id;
        if (existing) return { leadId: existing, linked: false, via: "existing" };

        for (const c of candidatePhones(app)) {
            const leadId = await findExistingLeadByPhone(c.phone);
            if (!leadId) continue;
            const claimed = (await runner.execute(sql`
                UPDATE dealer_onboarding_applications app
                   SET originating_dealer_lead_id = ${leadId}, updated_at = now()
                 WHERE app.id = ${applicationId}
                   AND app.originating_dealer_lead_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM dealer_onboarding_applications o
                                    WHERE o.originating_dealer_lead_id = ${leadId})
                RETURNING app.id
            `)) as unknown as Array<{ id: string }>;
            if (claimed.length === 0) {
                // Another application (usually an earlier draft for the same
                // dealer) already holds this lead. Leave both sides alone —
                // the lead's back-reference belongs to the holder.
                return { leadId, linked: false, via: c.via };
            }
            await runner.execute(sql`
                UPDATE dealer_leads
                   SET dealer_onboarding_application_id = ${applicationId}, updated_at = now()
                 WHERE id = ${leadId}
                   AND dealer_onboarding_application_id IS NULL
            `);
            return { leadId, linked: true, via: c.via };
        }
        return none;
    } catch (err) {
        console.warn("[linkOnboardingToLead] skipped", applicationId, err);
        return none;
    }
}
