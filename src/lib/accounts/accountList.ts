/**
 * Dealer accounts, one row each (tracker IDs 65 and 41, E-322).
 *
 * WHO. Every account that belongs to an activated dealer (a `dealers` row) —
 * including dealers onboarded directly, with no lead behind them. This is the
 * set "Converted" is counted from; Account management, dealer health and the
 * Dealer accounts download all read it here, so they cannot disagree.
 *
 * ORDERS are the account's invoices: matched on the ACCOUNT's GSTIN, non-void,
 * drafts counted (the revenue rule). While the account's GSTIN is still
 * "PENDING" the originating lead's GSTIN match is used instead.
 *
 * Calendar days in IST; "today" comes from Postgres.
 */
// Owner, onboarded-by and came-through are read from account_ownership /
// account_owner_history (E-321, the account model kept after the 5 Oct merge) —
// not from columns on `accounts`. One model, so this list and the Accounts
// screens cannot disagree about who owns a dealer.
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { accountBucket, type AccountBucket } from "@/lib/dealers/accountHealthRules";
import { GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { SALESPERSON_ROLES } from "@/lib/onboarding/salesperson";

/** What the approve route writes when the onboarding carried no GSTIN. */
export const GSTIN_PENDING = "PENDING";

export type AccountRow = {
    account_id: string;
    dealer: string;
    gstin: string | null;
    gstin_missing: boolean;
    /**
     * No GSTIN on the account and no lead to fall back on, so no invoice can be
     * matched: "never ordered" here means "cannot tell", not "did not buy".
     */
    invoices_unmatchable: boolean;
    city: string | null;
    state: string | null;
    dealer_type: string | null;
    finance_enabled: boolean;
    agreement_status: string | null;
    business_type: string | null;
    application_id: string | null;
    gst_certificate_on_file: boolean;
    activated_on: string | null;
    came_through: "lead" | "direct" | null;
    lead_id: string | null;
    onboarded_by_id: string | null;
    onboarded_by_name: string | null;
    owner_id: string | null;
    owner_name: string | null;
    owner_since: string | null;
    /** A hint for the "No owner" queue — never applied automatically. */
    suggested_owner_id: string | null;
    suggested_owner_name: string | null;
    suggested_owner_why: string | null;
    first_order: string | null;
    last_order: string | null;
    days_since_last_order: number | null;
    days_since_activation: number | null;
    orders: number;
    revenue_90d: number;
    revenue_fy: number;
    revenue_lifetime: number;
    avg_reorder_days: number | null;
    /** For the reorder rate (M29): an invoice in the last 30 days / before them. */
    ordered_last_30d: boolean;
    ordered_before_30d: boolean;
    bucket: AccountBucket;
};

export type AccountFilters = {
    ownerId?: string | null;
    onboardedById?: string | null;
    cameThrough?: "lead" | "direct" | null;
    bucket?: AccountBucket | null;
    dealerType?: string | null;
    noOwnerOnly?: boolean;
    gstinMissingOnly?: boolean;
    search?: string | null;
};

const last10 = (expr: SQL): SQL => sql`right(regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), 10)`;
const ROLES = sql.join(SALESPERSON_ROLES.map((r) => sql`${r}`), sql`, `);

const day = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export async function listAccounts(f: AccountFilters = {}): Promise<AccountRow[]> {
    const invoices = await matchedUnion();
    const conds: SQL[] = [sql`TRUE`];
    if (f.ownerId) conds.push(sql`ao.owner_user_id::text = ${f.ownerId}`);
    if (f.onboardedById) conds.push(sql`ao.onboarded_by_user_id::text = ${f.onboardedById}`);
    if (f.cameThrough) conds.push(sql`ao.came_through = ${f.cameThrough}`);
    if (f.dealerType) conds.push(sql`d.dealer_type = ${f.dealerType}`);
    if (f.noOwnerOnly) conds.push(sql`ao.owner_user_id IS NULL`);
    if (f.gstinMissingOnly) conds.push(sql`upper(btrim(a.gstin)) = ${GSTIN_PENDING}`);
    if (f.search?.trim()) {
        const like = `%${f.search.trim()}%`;
        conds.push(sql`(a.business_entity_name ILIKE ${like} OR a.gstin ILIKE ${like} OR a.city ILIKE ${like} OR a.id ILIKE ${like})`);
    }

    const rows = (await db.execute(sql`
        WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
        fy AS (
            SELECT make_date(
                EXTRACT(YEAR FROM (SELECT d FROM today))::int
                  - CASE WHEN EXTRACT(MONTH FROM (SELECT d FROM today)) < 4 THEN 1 ELSE 0 END, 4, 1) AS start
        ),
        acct AS (
            SELECT a.id,
                   CASE WHEN upper(btrim(a.gstin)) = ${GSTIN_PENDING} THEN NULL
                        ELSE ${GSTIN_KEY(sql`a.gstin`)} END AS gkey,
                   ao.source_dealer_lead_id AS lead_id
              FROM accounts a
                LEFT JOIN account_ownership ao ON ao.account_id = a.id
             WHERE EXISTS (SELECT 1 FROM dealers d WHERE d.dealer_id = a.id)
        ),
        orders AS (
            SELECT ac.id                             AS account_id,
                   COUNT(*)                          AS n,
                   MIN(r.invoice_date)               AS first_order,
                   MAX(r.invoice_date)               AS last_order,
                   COALESCE(SUM(r.total), 0)         AS lifetime,
                   COALESCE(SUM(r.total) FILTER (
                       WHERE r.invoice_date > (SELECT d FROM today) - 90), 0) AS last_90d,
                   COALESCE(SUM(r.total) FILTER (
                       WHERE r.invoice_date >= (SELECT start FROM fy)), 0)    AS this_fy,
                   COUNT(DISTINCT r.invoice_date)    AS order_days,
                   bool_or(r.invoice_date >= (SELECT d FROM today) - 30) AS within_30d,
                   bool_or(r.invoice_date <  (SELECT d FROM today) - 30) AS before_30d
              FROM acct ac
              JOIN ${invoices} AS r
                ON (ac.gkey IS NOT NULL AND r.gstin_key = ac.gkey)
                OR (ac.gkey IS NULL AND ac.lead_id IS NOT NULL AND r.dealer_lead_id = ac.lead_id)
             WHERE ${REVENUE_NOT_VOID}
             GROUP BY ac.id
        )
        SELECT a.id                                              AS account_id,
               COALESCE(a.business_entity_name, '(unnamed)')     AS dealer,
               a.gstin,
               (upper(btrim(a.gstin)) = ${GSTIN_PENDING})        AS gstin_missing,
               a.city, a.state,
               d.dealer_type,
               COALESCE(d.finance_enabled, false)                AS finance_enabled,
               app.agreement_status,
               to_jsonb(dl) ->> 'business_type'                  AS business_type,
               app.id::text                                      AS application_id,
               EXISTS (SELECT 1 FROM dealer_onboarding_documents doc
                        WHERE doc.application_id::text = app.id::text
                          AND doc.document_type IN ('gst_certificate', 'gst')
                          AND COALESCE(doc.doc_status, '') <> 'superseded') AS gst_certificate_on_file,
               (COALESCE((to_jsonb(a) ->> 'activated_at')::timestamptz, a.created_at) AT TIME ZONE 'Asia/Kolkata')::date AS activated_on,
               ao.came_through,
               ao.source_dealer_lead_id                      AS lead_id,
               ao.onboarded_by_user_id::text                      AS onboarded_by_id,
               ob.name                                           AS onboarded_by_name,
               ao.owner_user_id::text                          AS owner_id,
               ow.name                                           AS owner_name,
               (SELECT (h.effective_from AT TIME ZONE 'Asia/Kolkata')::date FROM account_owner_history h WHERE h.account_id = a.id AND h.effective_to IS NULL LIMIT 1)                             AS owner_since,
               sug.user_id::text                                 AS suggested_owner_id,
               sug.name                                          AS suggested_owner_name,
               sug.why                                           AS suggested_owner_why,
               o.first_order, o.last_order,
               ((SELECT d FROM today) - o.last_order)            AS days_since_last_order,
               ((SELECT d FROM today)
                  - (COALESCE((to_jsonb(a) ->> 'activated_at')::timestamptz, a.created_at) AT TIME ZONE 'Asia/Kolkata')::date) AS days_since_activation,
               COALESCE(o.n, 0)                                  AS orders,
               COALESCE(o.last_90d, 0)                           AS revenue_90d,
               COALESCE(o.this_fy, 0)                            AS revenue_fy,
               COALESCE(o.lifetime, 0)                           AS revenue_lifetime,
               CASE WHEN o.order_days > 1
                    THEN ROUND((o.last_order - o.first_order)::numeric / (o.order_days - 1), 1)
               END                                               AS avg_reorder_days,
               COALESCE(o.within_30d, false)                     AS ordered_last_30d,
               COALESCE(o.before_30d, false)                     AS ordered_before_30d
          FROM accounts a
            LEFT JOIN account_ownership ao ON ao.account_id = a.id
          JOIN dealers d ON d.dealer_id = a.id
          LEFT JOIN dealer_onboarding_applications app ON app.id::text = d.application_id
          LEFT JOIN dealer_leads dl ON dl.id = ao.source_dealer_lead_id
          LEFT JOIN users ob ON ob.id = ao.onboarded_by_user_id
          LEFT JOIN users ow ON ow.id = ao.owner_user_id
          LEFT JOIN orders o ON o.account_id = a.id
          -- The suggestion is only worked out for accounts with no owner. Order
          -- of trust: the onboarding's own salesperson, the staff member who
          -- filled the form, the typed sales manager matched to a CRM user,
          -- then the closing owner of a lead with the same GSTIN or phone.
          LEFT JOIN LATERAL (
              SELECT s.user_id, u.name, s.why
                FROM (
                    SELECT app.salesperson_user_id AS user_id, 'Salesperson on the onboarding' AS why, 1 AS rank
                    UNION ALL
                    SELECT app.onboarding_operator_id, 'Filled the onboarding form', 2
                    UNION ALL
                    SELECT su.id, 'Typed as sales manager on the onboarding', 3
                      FROM users su
                     WHERE (app.sales_manager_email IS NOT NULL
                            AND lower(su.email) = lower(btrim(app.sales_manager_email)))
                        OR (length(${last10(sql`app.sales_manager_mobile`)}) = 10
                            AND ${last10(sql`su.phone`)} = ${last10(sql`app.sales_manager_mobile`)})
                    UNION ALL
                    SELECT sl.closing_owner_id::uuid, 'Closed a lead with the same GSTIN or phone', 4
                      FROM dealer_leads sl
                     WHERE sl.closing_owner_id ~* '^[0-9a-f-]{36}$'
                       AND ((${GSTIN_KEY(sql`sl.gstin`)} IS NOT NULL
                             AND upper(btrim(a.gstin)) <> ${GSTIN_PENDING}
                             AND ${GSTIN_KEY(sql`sl.gstin`)} = ${GSTIN_KEY(sql`a.gstin`)})
                            OR (length(${last10(sql`a.contact_phone`)}) = 10
                                AND ${last10(sql`sl.phone`)} = ${last10(sql`a.contact_phone`)}))
                ) s
                JOIN users u ON u.id = s.user_id
               WHERE ao.owner_user_id IS NULL
                 AND u.is_active
                 AND lower(u.role) IN (${ROLES})
               ORDER BY s.rank
               LIMIT 1
          ) sug ON TRUE
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY days_since_last_order DESC NULLS FIRST, dealer
    `)) as unknown as Array<Record<string, unknown>>;

    const mapped = rows.map((r): AccountRow => {
        const sinceOrder = num(r.days_since_last_order);
        const sinceActivation = num(r.days_since_activation);
        return {
            account_id: String(r.account_id),
            dealer: String(r.dealer),
            gstin: (r.gstin as string | null) ?? null,
            gstin_missing: r.gstin_missing === true,
            invoices_unmatchable: r.gstin_missing === true && !r.lead_id,
            city: (r.city as string | null) ?? null,
            state: (r.state as string | null) ?? null,
            dealer_type: (r.dealer_type as string | null) ?? null,
            finance_enabled: r.finance_enabled === true,
            agreement_status: (r.agreement_status as string | null) ?? null,
            business_type: (r.business_type as string | null) ?? null,
            application_id: (r.application_id as string | null) ?? null,
            gst_certificate_on_file: r.gst_certificate_on_file === true,
            activated_on: day(r.activated_on),
            came_through: (r.came_through as "lead" | "direct" | null) ?? null,
            lead_id: (r.lead_id as string | null) ?? null,
            onboarded_by_id: (r.onboarded_by_id as string | null) ?? null,
            onboarded_by_name: (r.onboarded_by_name as string | null) ?? null,
            owner_id: (r.owner_id as string | null) ?? null,
            owner_name: (r.owner_name as string | null) ?? null,
            owner_since: day(r.owner_since),
            suggested_owner_id: (r.suggested_owner_id as string | null) ?? null,
            suggested_owner_name: (r.suggested_owner_name as string | null) ?? null,
            suggested_owner_why: (r.suggested_owner_why as string | null) ?? null,
            first_order: day(r.first_order),
            last_order: day(r.last_order),
            days_since_last_order: sinceOrder,
            days_since_activation: sinceActivation,
            orders: Number(r.orders ?? 0),
            revenue_90d: Number(r.revenue_90d ?? 0),
            revenue_fy: Number(r.revenue_fy ?? 0),
            revenue_lifetime: Number(r.revenue_lifetime ?? 0),
            avg_reorder_days: num(r.avg_reorder_days),
            ordered_last_30d: r.ordered_last_30d === true,
            ordered_before_30d: r.ordered_before_30d === true,
            bucket: accountBucket(sinceOrder, sinceActivation),
        };
    });
    // The bucket is the pure rule applied to the row, so it is filtered here.
    return f.bucket ? mapped.filter((r) => r.bucket === f.bucket) : mapped;
}

/** Headline counts for the Account management tabs. */
export async function countAccounts(): Promise<{ total: number; no_owner: number; gstin_missing: number }> {
    const [r] = (await db.execute(sql`
        SELECT COUNT(*)                                                         AS total,
               COUNT(*) FILTER (WHERE ao.owner_user_id IS NULL)               AS no_owner,
               COUNT(*) FILTER (WHERE upper(btrim(a.gstin)) = ${GSTIN_PENDING}) AS gstin_missing
          FROM accounts a
            LEFT JOIN account_ownership ao ON ao.account_id = a.id
         WHERE EXISTS (SELECT 1 FROM dealers d WHERE d.dealer_id = a.id)
    `)) as unknown as Array<Record<string, unknown>>;
    return { total: Number(r?.total ?? 0), no_owner: Number(r?.no_owner ?? 0), gstin_missing: Number(r?.gstin_missing ?? 0) };
}
