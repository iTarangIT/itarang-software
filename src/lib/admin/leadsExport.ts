/**
 * B11 — the full leads export: one row per dealer lead with its status, owner,
 * last / next visit, last / next call, latest remarks, and billing to date.
 *
 * ASSUMPTION A12 (one line to change): "Business till date" = INVOICED value,
 * i.e. SUM(total) over the dealer's sales invoices. See BILLING_SOURCE below.
 *
 * HOW A LEAD FINDS ITS INVOICES. There is no key. `orders` is empty on every
 * environment, `invoices` is the buyback deal ledger, and dealer billing lives
 * in `sales_invoices` (AI-read PDFs) and `zoho_invoices` (Zoho sync), both of
 * which identify the customer by NAME (and, on sales_invoices, GSTIN). No
 * dealer lead carries a GSTIN or a dealer account id, so the only join is
 * customer name = the lead's dealer name or shop name, case-folded and
 * trimmed. That is a BEST-EFFORT match and the sheet says so: the "Billing
 * match" column reads "name" when invoices were found that way and "none"
 * otherwise, so a blank is never mistaken for zero business. When onboarding
 * starts stamping the lead's GSTIN, swap the join in BILLING_KEY and the
 * column becomes exact — nothing else changes.
 *
 * DEFINITIONS
 *   Sales POC            dealer_leads.current_owner_id → users.name. The spec
 *                        says "from lead_assignments"; that table is EMPTY on
 *                        sandbox and every screen reads current_owner_id.
 *   Last visit           MAX(lead_visits.actual_visit_date)
 *   Next visit           MIN(lead_visits.scheduled_date) on/after today (IST),
 *                        visit still open
 *   Last call            MAX(performed_at) over inside_sales_call / ai_call
 *   Next call            MIN(next_action_at) on/after now, over the same rows
 *   Latest remarks       remarks of the most recent touchpoint of ANY type
 *   Business till date   Σ invoice total over both invoice tables (deduped by
 *                        invoice number — a Zoho invoice also read as a PDF
 *                        must not count twice)
 *   Last billing date    MAX(invoice_date)
 *   Visits before first  COUNT(lead_visits) with actual_visit_date < MIN(invoice_date)
 *   billing
 *
 * Every aggregate is a CTE joined once; no per-row queries. Dates come back as
 * real dates / timestamps so the workbook can store them as Excel dates.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildExportWhere, type LeadListFilters } from "@/lib/leads/leadListQuery";

/** A12 — what "business" means. Change this one fragment to switch the source. */
const BILLING_SOURCE = sql`
    -- sales_invoices first (has GSTIN); zoho rows whose number is already
    -- present are skipped so a synced invoice that was also read as a PDF is
    -- counted once.
    SELECT lower(trim(si.customer_name)) AS customer_key,
           si.invoice_number, si.invoice_date::date AS invoice_date, si.total::numeric AS total
      FROM sales_invoices si
     WHERE si.invoice_date IS NOT NULL
    UNION ALL
    SELECT lower(trim(z.customer_name)), z.invoice_number, z.invoice_date::date, z.total::numeric
      FROM zoho_invoices z
     WHERE z.invoice_date IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sales_invoices s2 WHERE s2.invoice_number = z.invoice_number)
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
    interest_level: string | null;
    owner_name: string | null;
    last_visit_date: string | null;
    next_visit_date: string | null;
    last_call_at: string | null;
    next_call_at: string | null;
    latest_remarks: string | null;
    business_till_date: string | null;
    last_billing_date: string | null;
    visits_before_first_billing: number | null;
    billing_match: "name" | "none";
}

export const LEADS_EXPORT_ROW_CAP = 50_000;

/** How many leads match — checked BEFORE the heavy query so the cap can refuse cleanly. */
export async function countLeadsForExport(f: LeadListFilters): Promise<number> {
    const where = buildExportWhere(f);
    const rows = (await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE ${where}
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
        inv AS (${BILLING_SOURCE}),
        billing AS (
            -- BILLING_KEY: the lead ↔ invoice join. Name match today; see header.
            SELECT dl.id AS dealer_lead_id,
                   SUM(i.total)         AS business_till_date,
                   MAX(i.invoice_date)  AS last_billing_date,
                   MIN(i.invoice_date)  AS first_billing_date
              FROM dealer_leads dl
              JOIN inv i ON i.customer_key IN (lower(trim(dl.dealer_name)), lower(trim(dl.shop_name)))
             WHERE ${where}
             GROUP BY dl.id
        ),
        pre_bill AS (
            SELECT b.dealer_lead_id, COUNT(v.visit_id)::int AS visits_before_first_billing
              FROM billing b
              LEFT JOIN lead_visits v
                ON v.dealer_lead_id = b.dealer_lead_id
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
               dl.interest_level,
               owner.name                             AS owner_name,
               vi.last_visit_date::text               AS last_visit_date,
               vi.next_visit_date::text               AS next_visit_date,
               c.last_call_at::text                   AS last_call_at,
               c.next_call_at::text                   AS next_call_at,
               r.remarks                              AS latest_remarks,
               b.business_till_date::text             AS business_till_date,
               b.last_billing_date::text              AS last_billing_date,
               pb.visits_before_first_billing,
               CASE WHEN b.dealer_lead_id IS NULL THEN 'none' ELSE 'name' END AS billing_match
          FROM dealer_leads dl
          LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
          LEFT JOIN visits vi ON vi.dealer_lead_id = dl.id
          LEFT JOIN calls c ON c.dealer_lead_id = dl.id
          LEFT JOIN remarks r ON r.dealer_lead_id = dl.id
          LEFT JOIN billing b ON b.dealer_lead_id = dl.id
          LEFT JOIN pre_bill pb ON pb.dealer_lead_id = dl.id
         WHERE ${where}
         ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
         LIMIT ${limit}
    `);
    return rows as unknown as LeadsExportRow[];
}
