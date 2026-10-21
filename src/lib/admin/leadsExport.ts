/**
 * B11 — the full leads export: one row per dealer lead with its status, owner,
 * last / next visit, last / next call, latest remarks, and billing to date.
 *
 * ASSUMPTION A12: "Business till date" = INVOICED value, i.e. SUM(total) over
 * the dealer's invoices, less its credit notes. See billingSource below.
 *
 * HOW A LEAD FINDS ITS INVOICES (IDs 70 / 71, 18 Oct). The ONE revenue list —
 * matchedUnion() in src/lib/dashboard/revenueSource.ts: Drive / Vyapar and
 * Zoho invoices plus credit notes, voids out, each matched to a dealer the
 * same way Dealer Health, Accounts and Data downloads › Leads do:
 *   1. the dealer ACCOUNT — a hand link (invoice_account_links), else the
 *      account's GSTIN or one of its aliases; the lead is the account's
 *      source lead;
 *   2. otherwise the lead / onboarding GSTIN (src/lib/leads/gstinMatch.ts).
 * The old customer-name match is gone. "Billing match" says which link found
 * the invoices ('hand link', 'account', 'gstin') or 'none', so a blank is never
 * mistaken for zero business.
 *
 * DEFINITIONS
 *   Sales POC            dealer_leads.current_owner_id → users.name. The spec
 *                        says "from lead_assignments"; that table is EMPTY on
 *                        sandbox and every screen reads current_owner_id.
 *   Closed by            dealer_leads.closing_owner_id → users.name, on a Won /
 *                        Converted / Lost lead (tracker ID 117). Sales POC is
 *                        whoever holds the lead TODAY; a conversion belongs to
 *                        this person and does not move when the lead is
 *                        reassigned — count conversions on this column.
 *   Last visit           MAX(lead_visits.actual_visit_date)
 *   Next visit           MIN(lead_visits.scheduled_date) on/after today (IST),
 *                        visit still open
 *   Last call            MAX(performed_at) over inside_sales_call / ai_call
 *   Next call            MIN(next_action_at) on/after now, over the same rows
 *   Latest remarks       remarks of the most recent touchpoint of ANY type
 *   Business till date   Σ total of the matched non-void invoices, LESS the
 *                        matched credit notes (negative rows) — the same rows
 *                        as the Revenue card
 *   Last billing date    MAX(invoice_date) over invoices; credit notes ignored
 *   Visits before first  COUNT(lead_visits) with actual_visit_date < the first
 *   billing              invoice date (credit notes ignored)
 *
 * Every aggregate is a CTE joined once; no per-row queries. Dates come back as
 * real dates / timestamps so the workbook can store them as Excel dates.
 */

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, REVENUE_IS_CREDIT, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { aiSignalsJoin, buildExportWhere, type LeadListFilters } from "@/lib/leads/leadListQuery";

/**
 * A12 — what "business" means, per matched lead: every non-void document of
 * the one revenue list. Credit notes are negative rows, so the sum nets them
 * (ID 71); they are never a billing DATE — a credit note is money back, not an
 * order (REVENUE_IS_CREDIT), so last / first billing read invoices only.
 */
const billingSource = (matched: SQL) => sql`
    SELECT r.dealer_lead_id::text                                    AS dealer_lead_id,
           SUM(COALESCE(r.total, 0))                                 AS business_till_date,
           MAX(r.invoice_date) FILTER (WHERE NOT ${REVENUE_IS_CREDIT}) AS last_billing_date,
           MIN(r.invoice_date) FILTER (WHERE NOT ${REVENUE_IS_CREDIT}) AS first_billing_date,
           -- How the invoices were found: a hand link beats the account
           -- GSTIN, which beats the lead / onboarding GSTIN.
           CASE WHEN bool_or(r.link_kind = 'linked') THEN 'hand link'
                WHEN bool_or(r.account_id IS NOT NULL) THEN 'account'
                ELSE 'gstin' END                                     AS billing_match
      FROM ${matched} AS r
     WHERE ${REVENUE_NOT_VOID} AND r.dealer_lead_id IS NOT NULL
     GROUP BY 1
`;

export type LeadsExportRow = {
    lead_id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    business_type: string | null;
    lead_status: string | null;
    /** ID 74 (E-314): when the rep marked it Won; null if never, or without E-314. */
    won_at: string | null;
    /** ID 74: Won with no dealer-approved quote. Only true while Won / Converted. */
    won_without_approved_quote: boolean | null;
    interest_level: string | null;
    owner_name: string | null;
    /** ID 117: who held the lead when it was won / lost; null on an open lead. */
    closed_by_name: string | null;
    last_visit_date: string | null;
    next_visit_date: string | null;
    last_call_at: string | null;
    next_call_at: string | null;
    latest_remarks: string | null;
    business_till_date: string | null;
    last_billing_date: string | null;
    visits_before_first_billing: number | null;
    /** IDs 70 / 71: which link matched the invoices — see the header. */
    billing_match: "hand link" | "account" | "gstin" | "none";
}

export const LEADS_EXPORT_ROW_CAP = 50_000;

/** How many leads match — checked BEFORE the heavy query so the cap can refuse cleanly. */
export async function countLeadsForExport(f: LeadListFilters): Promise<number> {
    const where = buildExportWhere(f);
    const rows = (await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads dl ${aiSignalsJoin(f)} WHERE ${where}
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
}

export async function fetchLeadsForExport(
    f: LeadListFilters,
    limit: number = LEADS_EXPORT_ROW_CAP,
): Promise<LeadsExportRow[]> {
    const where = buildExportWhere(f);
    const rows = await db.execute<LeadsExportRow>(sql`
        WITH today AS (
            SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d
        ),
        visits AS (
            SELECT v.dealer_lead_id,
                   MAX(v.actual_visit_date) AS last_visit_date,
                   MIN(v.scheduled_date) FILTER (
                       WHERE v.scheduled_date >= (SELECT d FROM today)
                         AND v.visit_status NOT IN ('visited', 'cancelled', 'no_show')
                   ) AS next_visit_date
              FROM lead_visits v
             GROUP BY v.dealer_lead_id
        ),
        calls AS (
            SELECT t.dealer_lead_id,
                   MAX(t.performed_at) AS last_call_at,
                   MIN(t.next_action_at) FILTER (WHERE t.next_action_at >= now()) AS next_call_at
              FROM lead_touchpoints t
             WHERE t.touchpoint_type IN ('inside_sales_call', 'ai_call')
             GROUP BY t.dealer_lead_id
        ),
        remarks AS (
            SELECT DISTINCT ON (t.dealer_lead_id) t.dealer_lead_id, t.remarks
              FROM lead_touchpoints t
             WHERE t.remarks IS NOT NULL AND trim(t.remarks) <> ''
             ORDER BY t.dealer_lead_id, t.performed_at DESC NULLS LAST, t.created_at DESC
        ),
        -- The lead ↔ invoice join: account / GSTIN match (matchedUnion), not name.
        billing AS (${billingSource(await matchedUnion())}),
        pre_bill AS (
            SELECT b.dealer_lead_id, COUNT(v.visit_id)::int AS visits_before_first_billing
              FROM billing b
              LEFT JOIN lead_visits v
                ON v.dealer_lead_id::text = b.dealer_lead_id
               AND v.actual_visit_date IS NOT NULL
               AND v.actual_visit_date < b.first_billing_date
             GROUP BY b.dealer_lead_id
        )
        SELECT dl.id                                  AS lead_id,
               dl.dealer_name,
               dl.shop_name,
               dl.phone,
               dl.city,
               dl.state,
               to_jsonb(dl) ->> 'business_type'      AS business_type,
               dl.lead_status,
               -- ID 74 (E-314), same to_jsonb guard as business_type. The flag
               -- is reported only while the lead is Won / Converted: a
               -- re-opened lead keeps the old value until its next Mark Won.
               CASE WHEN dl.lead_status IN ('Won', 'Converted')
                    THEN to_jsonb(dl) ->> 'won_at' END AS won_at,
               CASE WHEN dl.lead_status IN ('Won', 'Converted')
                    THEN (to_jsonb(dl) ->> 'won_without_approved_quote')::boolean END AS won_without_approved_quote,
               dl.interest_level,
               owner.name                             AS owner_name,
               -- ID 117: the closing owner, reported only on a closed lead.
               CASE WHEN dl.lead_status IN ('Won', 'Converted', 'Lost')
                    THEN closer.name END              AS closed_by_name,
               vi.last_visit_date::text               AS last_visit_date,
               vi.next_visit_date::text               AS next_visit_date,
               c.last_call_at::text                   AS last_call_at,
               c.next_call_at::text                   AS next_call_at,
               r.remarks                              AS latest_remarks,
               b.business_till_date::text             AS business_till_date,
               b.last_billing_date::text              AS last_billing_date,
               pb.visits_before_first_billing,
               COALESCE(b.billing_match, 'none')      AS billing_match
          FROM dealer_leads dl
          LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
          LEFT JOIN users closer ON closer.id::text = dl.closing_owner_id
          LEFT JOIN visits vi ON vi.dealer_lead_id = dl.id
          LEFT JOIN calls c ON c.dealer_lead_id = dl.id
          LEFT JOIN remarks r ON r.dealer_lead_id = dl.id
          LEFT JOIN billing b ON b.dealer_lead_id = dl.id::text
          LEFT JOIN pre_bill pb ON pb.dealer_lead_id = dl.id::text
          -- The AI filters (AI band, AI called, signals, callback) name ai.*;
          -- the join is emitted only when one is set, as on the lead list.
          ${aiSignalsJoin(f)}
         WHERE ${where}
         ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
         LIMIT ${limit}
    `);
    return rows as unknown as LeadsExportRow[];
}
