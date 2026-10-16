/**
 * Tracker ID 186 — isDealerOnboarded(dealerLeadId): the reader behind the rule
 * in ./dealerOnboardedRules.ts (read that header first).
 *
 * WHO the dealer is, from the lead:
 *   * onboarding applications linked to the lead (dealer_leads.
 *     dealer_onboarding_application_id or the application's
 *     originating_dealer_lead_id), or carrying the lead's phone (owner,
 *     WhatsApp or contact number, last 10 digits — the same match
 *     linkOnboardingToLead uses);
 *   * dealer accounts made from the lead (account_ownership.
 *     source_dealer_lead_id, E-321) or from one of those applications
 *     (accounts.id = dealer_code);
 *   * every GSTIN on the lead, those applications and those accounts (plus the
 *     accounts' alias GSTINs).
 *
 * ONBOARDED when one of those applications is approved, an account exists, or
 * a battery invoice matches: the revenue matcher's lead, account, or a GSTIN
 * above (matchedLinesUnion — void and credit notes excluded, lines mapped to
 * the onboarding fee never count as a battery).
 *
 * Read-only. Never throws: a failed check returns "not onboarded" with
 * checkFailed, so the quote form asks for the card exactly as before.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { matchedLinesUnion, REVENUE_IS_ORDER } from "@/lib/dashboard/revenueSource";
import { GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { ONBOARDING_FEE_ITEM } from "@/lib/leads/dealCardRules";
import {
    decideDealerOnboarded,
    type ApprovedOnboardingEvidence,
    type BatteryInvoiceEvidence,
    type DealerOnboardedVerdict,
} from "@/lib/leads/dealerOnboardedRules";

type Exec = Pick<typeof db, "execute">;

const rowsOf = <T>(res: unknown): T[] => res as T[];

const LAST10 = (expr: SQL): SQL => sql`right(regexp_replace(COALESCE(${expr}, ''), '\\D', '', 'g'), 10)`;

const inList = (values: string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);

type AppRow = {
    id: string;
    company_name: string | null;
    onboarding_status: string | null;
    approved_at: string | null;
    gst_key: string | null;
    dealer_code: string | null;
    via: "lead_link" | "phone";
};

type AccountRow = { id: string; name: string | null; created_at: string | null; from_lead: boolean; gst_key: string | null };

/** The dealer's identity: applications, accounts, GSTIN keys. Exported for the verify script. */
export async function dealerIdentityForLead(leadId: string, ex: Exec = db) {
    const leadRows = rowsOf<{ id: string; gst_key: string | null; p10: string }>(
        await ex.execute(sql`
            SELECT dl.id, ${GSTIN_KEY(sql`dl.gstin`)} AS gst_key, ${LAST10(sql`dl.phone`)} AS p10
              FROM dealer_leads dl WHERE dl.id = ${leadId}
        `),
    );
    const lead = leadRows[0];
    if (!lead) return null;
    const phoneMatch = lead.p10.length === 10;

    const apps = rowsOf<AppRow>(
        await ex.execute(sql`
            SELECT a.id::text AS id, a.company_name, a.onboarding_status,
                   a.approved_at::text AS approved_at,
                   ${GSTIN_KEY(sql`a.gst_number`)} AS gst_key,
                   a.dealer_code,
                   CASE WHEN a.id = dl.dealer_onboarding_application_id
                          OR a.originating_dealer_lead_id = dl.id THEN 'lead_link'
                        ELSE 'phone' END AS via
              FROM dealer_onboarding_applications a
              JOIN dealer_leads dl ON dl.id = ${leadId}
             WHERE a.id = dl.dealer_onboarding_application_id
                OR a.originating_dealer_lead_id = dl.id
                ${phoneMatch
                    ? sql`OR ${lead.p10} IN (${LAST10(sql`a.owner_phone`)}, ${LAST10(sql`a.wa_phone`)}, ${LAST10(sql`a.contact_phone`)})`
                    : sql``}
             ORDER BY (a.onboarding_status = 'approved') DESC, a.approved_at ASC NULLS LAST, a.created_at ASC
        `),
    );

    const codes = apps.map((a) => a.dealer_code).filter((c): c is string => !!c);
    const ownership = await hasAccountOwnershipTables();
    let accounts: AccountRow[] = [];
    if (ownership || codes.length) {
        const fromLead = ownership
            ? sql`EXISTS (SELECT 1 FROM account_ownership ao WHERE ao.account_id = ac.id AND ao.source_dealer_lead_id = ${leadId})`
            : sql`false`;
        accounts = rowsOf<AccountRow>(
            await ex.execute(sql`
                SELECT ac.id, ac.business_entity_name AS name, ac.created_at::text AS created_at,
                       ${fromLead} AS from_lead, ${GSTIN_KEY(sql`ac.gstin`)} AS gst_key
                  FROM accounts ac
                 WHERE ${fromLead}
                    ${codes.length ? sql`OR ac.id IN (${inList(codes)})` : sql``}
                 ORDER BY ac.created_at ASC
            `),
        );
    }

    const keys = new Set<string>();
    if (lead.gst_key) keys.add(lead.gst_key);
    for (const a of apps) if (a.gst_key) keys.add(a.gst_key);
    for (const ac of accounts) if (ac.gst_key && ac.gst_key !== "PENDING") keys.add(ac.gst_key);
    if (ownership && accounts.length) {
        const alias = rowsOf<{ k: string | null }>(
            await ex.execute(sql`
                SELECT ${GSTIN_KEY(sql`g.gstin`)} AS k FROM account_gstins g
                 WHERE g.account_id IN (${inList(accounts.map((a) => a.id))})
            `),
        );
        for (const r of alias) if (r.k) keys.add(r.k);
    }
    return { leadId, apps, accounts, gstinKeys: [...keys] };
}

/** The earliest battery invoice of this dealer, or null (also when E-322 is missing). */
export async function firstBatteryInvoice(
    identity: NonNullable<Awaited<ReturnType<typeof dealerIdentityForLead>>>,
    ex: Exec = db,
): Promise<BatteryInvoiceEvidence | null> {
    const lines = await matchedLinesUnion();
    if (!lines) return null;
    const accountIds = identity.accounts.map((a) => a.id);
    const ors: SQL[] = [sql`r.dealer_lead_id = ${identity.leadId}`];
    if (accountIds.length) ors.push(sql`r.account_id IN (${inList(accountIds)})`);
    if (identity.gstinKeys.length) ors.push(sql`r.gstin_key IN (${inList(identity.gstinKeys)})`);
    const rows = rowsOf<{ invoice_number: string | null; invoice_date: string | null; via: BatteryInvoiceEvidence["via"] }>(
        await ex.execute(sql`
            SELECT r.invoice_number, r.invoice_date::text AS invoice_date,
                   CASE WHEN r.dealer_lead_id = ${identity.leadId} THEN 'lead'
                        ${accountIds.length ? sql`WHEN r.account_id IN (${inList(accountIds)}) THEN 'account'` : sql``}
                        ELSE 'gstin' END AS via
              FROM ${lines} AS r
             WHERE ${REVENUE_IS_ORDER}
               AND r.link_kind IS DISTINCT FROM 'not_dealer'
               AND r.product_class = 'battery'
               AND r.asset_type IS DISTINCT FROM ${ONBOARDING_FEE_ITEM}
               AND r.product_id IS DISTINCT FROM ${ONBOARDING_FEE_ITEM}
               AND r.invoice_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
               AND (${sql.join(ors, sql` OR `)})
             ORDER BY r.invoice_date ASC, r.invoice_number ASC
             LIMIT 1
        `),
    );
    const r = rows[0];
    return r ? { invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, via: r.via } : null;
}

/** ID 186: is the dealer on this lead already onboarded? Never throws. */
export async function isDealerOnboarded(leadId: string, ex: Exec = db): Promise<DealerOnboardedVerdict> {
    try {
        const identity = await dealerIdentityForLead(leadId, ex);
        if (!identity) return decideDealerOnboarded({ approvedOnboarding: null, batteryInvoice: null });

        let approved: ApprovedOnboardingEvidence | null = null;
        const app = identity.apps.find((a) => a.onboarding_status === "approved");
        if (app) {
            approved = { applicationId: app.id, company: app.company_name, approvedAt: app.approved_at, via: app.via };
        } else {
            const acct = identity.accounts.find((a) => a.from_lead) ?? identity.accounts[0];
            if (acct) approved = { applicationId: null, company: acct.name, approvedAt: acct.created_at, via: "account" };
        }
        // The invoice is read even when an onboarding is approved, so the
        // verify script and the lead page can show both.
        const invoice = await firstBatteryInvoice(identity, ex);
        return decideDealerOnboarded({ approvedOnboarding: approved, batteryInvoice: invoice });
    } catch (err) {
        console.warn("[dealerOnboarded] check failed; treating as not onboarded", leadId, err);
        return decideDealerOnboarded({ approvedOnboarding: null, batteryInvoice: null, checkFailed: true });
    }
}
