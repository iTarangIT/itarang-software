/**
 * Post-approval bookkeeping for a dealer account (tracker IDs 5, 67 /
 * handover P1-1, P1-4). Called by the admin approve route AFTER its
 * transaction commits, best-effort — approval must never fail on this.
 *
 *   1. link the onboarding to its lead by phone (linkOnboardingToLead);
 *   2. record how the account came in — onboarded by, lead vs direct — in
 *      account_ownership. "Onboarded by" is the salesperson named on the
 *      onboarding (tracker ID 66, column salesperson_user_id) when there is
 *      one, else whoever keyed it in — information, not credit;
 *   2b. ID 159 (Kartik, 10 Oct): the lead's closer becomes the account owner
 *      by default (an active salesperson only, and only while the account has
 *      no owner). Admin changes it from the Accounts tab. A direct onboarding
 *      (no lead) stays unowned for a person to assign;
 *   3. write the verified GSTIN back to the linked lead when the lead has
 *      none, so the lead-side matcher agrees with the account.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { assignOwner, recordAccountOrigin } from "@/lib/accounts/ownership";
import { SALESPERSON_ROLES } from "@/lib/onboarding/salesperson";
import { linkOnboardingToLead } from "@/lib/onboarding/linkToLead";
import { checkCustomerGstin, normalizeGstin } from "@/lib/leads/gstin";

export async function onDealerAccountApproved(input: {
    applicationId: string;
    accountId: string;
    /** Who approved — recorded as who set the default owner (ID 159). */
    approvedBy?: string | null;
}): Promise<void> {
    try {
        const link = await linkOnboardingToLead(input.applicationId);
        const apps = (await db.execute(sql`
            SELECT app.owner_id, app.onboarding_operator_id::text AS operator_id, app.gst_number,
                   -- read through to_jsonb: NULL, not an error, on a DB without the column
                   to_jsonb(app) ->> 'salesperson_user_id' AS salesperson_id
              FROM dealer_onboarding_applications app WHERE app.id = ${input.applicationId}
        `)) as unknown as Array<{
            owner_id: string | null;
            operator_id: string | null;
            gst_number: string | null;
            salesperson_id: string | null;
        }>;
        const app = apps[0];

        if (await hasAccountOwnershipTables()) {
            await recordAccountOrigin(input.accountId, {
                onboardedBy: app?.salesperson_id ?? app?.owner_id ?? app?.operator_id ?? null,
                cameThrough: link.leadId ? "lead" : "direct",
                dealerLeadId: link.leadId,
                applicationId: input.applicationId,
            });
            if (link.leadId) await defaultOwnerToCloser(input.accountId, link.leadId, input.approvedBy ?? null);
        }

        // ID 62: valid AND not iTarang's own.
        if (link.leadId && app?.gst_number && checkCustomerGstin(app.gst_number) === "ok") {
            await db.execute(sql`
                UPDATE dealer_leads SET gstin = ${normalizeGstin(app.gst_number)}, updated_at = now()
                 WHERE id = ${link.leadId} AND (gstin IS NULL OR btrim(gstin) = '')
            `);
        }
    } catch (err) {
        console.warn("[onDealerAccountApproved] skipped", input, err);
    }
}

/**
 * ID 159: the closer of the lead becomes the account's first owner, unless the
 * account already has one or the closer is not an active salesperson.
 */
async function defaultOwnerToCloser(accountId: string, leadId: string, approvedBy: string | null): Promise<void> {
    const rows = (await db.execute(sql`
        SELECT u.id::text AS closer_id,
               (SELECT ao.owner_user_id::text FROM account_ownership ao WHERE ao.account_id = ${accountId}) AS owner_id
          FROM dealer_leads dl
          JOIN users u ON u.id::text = dl.closing_owner_id::text
         WHERE dl.id = ${leadId}
           AND u.is_active IS NOT FALSE
           AND lower(u.role) IN (${sql.join(SALESPERSON_ROLES.map((r) => sql`${r}`), sql`, `)})
    `)) as unknown as Array<{ closer_id: string; owner_id: string | null }>;
    const r = rows[0];
    if (!r || r.owner_id) return;
    await assignOwner([accountId], r.closer_id, {
        reason: "Default owner: closed the lead this dealer came from (ID 159)",
        actorId: approvedBy ?? r.closer_id,
    });
}
