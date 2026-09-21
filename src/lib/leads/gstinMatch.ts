/**
 * The ONE rule for "which CRM dealer lead is this GSTIN?" (review R-11), as
 * SQL fragments. Used wherever money or stock has a GSTIN but no lead id:
 *   * invoices          revenueSource.ts matchedUnion()        (revenue)
 *   * dealer accounts   salesDashboard.ts queryTotals()        (batteries, KYC)
 * One definition, so an invoice and a battery allocation for the same dealer
 * can never credit two different salespeople.
 *
 * A GSTIN matches a lead when it equals, after GSTIN_KEY normalisation:
 *   * dealer_leads.gstin — required at Mark Converted since R-11, or
 *   * the GST number on the lead's dealer onboarding application.
 * Several leads with one GSTIN: a Converted lead wins, then the most recently
 * closed, then the oldest — deterministic, so a dealer never flips owner
 * between two page loads.
 *
 * The TypeScript twin of GSTIN_KEY is normalizeGstin() in ./gstin.ts; keep
 * them in step.
 */
import { sql, type SQL } from "drizzle-orm";

/** A GSTIN as a join key: whitespace removed, upper-cased, '' -> NULL. */
export const GSTIN_KEY = (expr: SQL): SQL =>
    sql`NULLIF(upper(regexp_replace(COALESCE(${expr}, ''), '\\s', '', 'g')), '')`;

/**
 * `LATERAL (…)` yielding at most one row — dealer_lead_id, dealer_name,
 * dealer_owner_id — for the lead matching `key` (an already-normalised
 * GSTIN_KEY expression). Use as `LEFT JOIN ${dealerLeadByGstin(k)} m ON TRUE`.
 * Internal aliases are prefixed gm_ so they cannot shadow the caller's.
 */
export function dealerLeadByGstin(key: SQL): SQL {
    return sql`LATERAL (
        SELECT gm_dl.id                                           AS dealer_lead_id,
               COALESCE(gm_dl.shop_name, gm_dl.dealer_name)       AS dealer_name,
               gm_dl.current_owner_id                             AS dealer_owner_id
          FROM dealer_leads gm_dl
          LEFT JOIN dealer_onboarding_applications gm_app
                 ON gm_app.id = gm_dl.dealer_onboarding_application_id
         WHERE ${key} IS NOT NULL
           AND (${GSTIN_KEY(sql`gm_dl.gstin`)} = ${key}
                OR ${GSTIN_KEY(sql`gm_app.gst_number`)} = ${key})
         ORDER BY (gm_dl.lead_status = 'Converted') DESC,
                  gm_dl.closed_at DESC NULLS LAST,
                  gm_dl.created_at ASC
         LIMIT 1
    )`;
}
