/**
 * Post-approval bookkeeping for a dealer account (tracker IDs 5, 67 /
 * handover P1-1, P1-4). Called by the admin approve route AFTER its
 * transaction commits, best-effort — approval must never fail on this.
 *
 *   1. link the onboarding to its lead by phone (linkOnboardingToLead);
 *   2. record how the account came in — onboarded by, lead vs direct — in
 *      account_ownership. The OWNER is left empty: a person assigns it from
 *      the Accounts tab ("nothing is assigned automatically"). "Onboarded by"
 *      is the salesperson named on the onboarding (tracker ID 66, column
 *      salesperson_user_id) when there is one, else whoever keyed it in;
 *   3. write the verified GSTIN back to the linked lead when the lead has
 *      none, so the lead-side matcher agrees with the account.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { recordAccountOrigin } from "@/lib/accounts/ownership";
import { linkOnboardingToLead } from "@/lib/onboarding/linkToLead";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";

export async function onDealerAccountApproved(input: {
    applicationId: string;
    accountId: string;
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
        }

        if (link.leadId && app?.gst_number && isValidGstin(app.gst_number)) {
            await db.execute(sql`
                UPDATE dealer_leads SET gstin = ${normalizeGstin(app.gst_number)}, updated_at = now()
                 WHERE id = ${link.leadId} AND (gstin IS NULL OR btrim(gstin) = '')
            `);
        }
    } catch (err) {
        console.warn("[onDealerAccountApproved] skipped", input, err);
    }
}
