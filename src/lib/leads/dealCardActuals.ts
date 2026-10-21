/**
 * ID 172 items 5–7 — what actually happened against a quote's deal card, per
 * dealer lead, from the invoice lines (E-322; never stock allocation):
 *
 *   fee_invoiced         Σ amount (before GST) of lines mapped "Onboarding fee"
 *                        in Invoice Ledger › Item mapping (ONBOARDING_FEE_ITEM)
 *   batteries_60d        Σ battery units (product_class 'battery') invoiced in
 *                        the 60 days from the lead's Won day (won_at, IST)
 *
 * Same invoice → lead match and void rule as revenue (revenueSource.ts).
 * A14: an invoice matched to a dealer ACCOUNT carries a lead only when the
 * account records its source lead; otherwise the lead with the invoice's
 * GSTIN is used (the same GSTIN rule as revenue's lead matcher), so an
 * account-matched order is not dropped from "Batteries ordered in the 60
 * days after Won". Returns null when the invoice-line tables are missing
 * (E-322 not applied).
 */
import { sql, type SQL } from "drizzle-orm";
import { matchedLinesUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { ONBOARDING_FEE_ITEM } from "@/lib/leads/dealCardRules";
import { leadKeyValidOn, leadsByGstinKey } from "@/lib/leads/gstinMatch";

/** Days after Won the volume check looks at (Kartik, 10 Oct). */
export const VOLUME_CHECK_DAYS = 60;

/**
 * A CTE body keyed by dealer_lead_id: lead_id, fee_invoiced, batteries_60d.
 * Join it to dealer_leads / commercials as `LEFT JOIN (<this>) da ON da.lead_id = …`.
 */
export async function dealCardActualsSql(): Promise<SQL | null> {
    const lines = await matchedLinesUnion();
    if (!lines) return null;
    return sql`
        SELECT COALESCE(r.dealer_lead_id, gk.dealer_lead_id) AS lead_id,
               COALESCE(SUM(r.amount_excl_gst) FILTER (WHERE r.asset_type = ${ONBOARDING_FEE_ITEM}), 0)::float8 AS fee_invoiced,
               COALESCE(SUM(r.quantity) FILTER (
                   WHERE r.product_class = 'battery'
                     AND (to_jsonb(dl) ->> 'won_at') IS NOT NULL
                     AND r.invoice_date >= ((to_jsonb(dl) ->> 'won_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
                     AND r.invoice_date < ((to_jsonb(dl) ->> 'won_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
                                          + ${sql.raw(String(VOLUME_CHECK_DAYS))}
               ), 0)::float8 AS batteries_60d
          FROM ${lines} AS r
          LEFT JOIN (${leadsByGstinKey()}) gk
                 ON r.dealer_lead_id IS NULL AND r.account_id IS NOT NULL AND gk.k = r.gstin_key
                AND ${leadKeyValidOn("gk", sql`r.invoice_date`)}
          JOIN dealer_leads dl ON dl.id = COALESCE(r.dealer_lead_id, gk.dealer_lead_id)
         WHERE ${REVENUE_NOT_VOID}
         GROUP BY 1`;
}
