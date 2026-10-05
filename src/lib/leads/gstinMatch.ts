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
         ORDER BY (gm_dl.lead_status IN ('Converted', 'Won')) DESC,
                  gm_dl.closed_at DESC NULLS LAST,
                  gm_dl.created_at ASC
         LIMIT 1
    )`;
}

/**
 * The lead rule above as ONE keyed set — GSTIN key → the winning lead — for
 * matching many rows at once (revenueSource.matchedUnion). Same candidates
 * (dealer_leads.gstin, the linked onboarding's GST number) and the same tie
 * order as dealerLeadByGstin, so the two can never disagree; built once and
 * hash-joined instead of searching dealer_leads once per invoice, which got
 * slow as soon as most invoices carried a GSTIN (E-322 Zoho backfill).
 * Columns: k, dealer_lead_id, dealer_name, dealer_owner_id.
 */
export function leadsByGstinKey(): SQL {
    return sql`
        SELECT DISTINCT ON (lk.k) lk.k, lk.dealer_lead_id, lk.dealer_name, lk.dealer_owner_id
          FROM (
            SELECT ${GSTIN_KEY(sql`gm_dl.gstin`)}                  AS k,
                   gm_dl.id                                       AS dealer_lead_id,
                   COALESCE(gm_dl.shop_name, gm_dl.dealer_name)   AS dealer_name,
                   gm_dl.current_owner_id                         AS dealer_owner_id,
                   gm_dl.lead_status, gm_dl.closed_at, gm_dl.created_at
              FROM dealer_leads gm_dl
            UNION ALL
            SELECT ${GSTIN_KEY(sql`gm_app.gst_number`)},
                   gm_dl.id, COALESCE(gm_dl.shop_name, gm_dl.dealer_name), gm_dl.current_owner_id,
                   gm_dl.lead_status, gm_dl.closed_at, gm_dl.created_at
              FROM dealer_leads gm_dl
              JOIN dealer_onboarding_applications gm_app
                ON gm_app.id = gm_dl.dealer_onboarding_application_id
          ) lk
         WHERE lk.k IS NOT NULL
         ORDER BY lk.k,
                  (lk.lead_status IN ('Converted', 'Won')) DESC,
                  lk.closed_at DESC NULLS LAST,
                  lk.created_at ASC`;
}

/**
 * E-321 (tracker IDs 68, 69 / handover P1-5) — GSTIN key → dealer ACCOUNT, as
 * one keyed set: the account's primary GSTIN and every account_gstins alias
 * (a corrected predecessor, or one learned by "Link to account"). Oldest
 * account wins a tie. Columns: k, account_id, account_name. Requires E-321.
 */
export function accountsByGstinKey(): SQL {
    return sql`
        SELECT DISTINCT ON (ak.k) ak.k, ak.account_id, ak.account_name
          FROM (
            SELECT ${GSTIN_KEY(sql`ga_a.gstin`)} AS k, ga_a.id AS account_id,
                   ga_a.business_entity_name AS account_name, ga_a.created_at
              FROM accounts ga_a
            UNION ALL
            SELECT ga_g.gstin, ga_a.id, ga_a.business_entity_name, ga_a.created_at
              FROM account_gstins ga_g
              JOIN accounts ga_a ON ga_a.id = ga_g.account_id
          ) ak
         WHERE ak.k IS NOT NULL
         ORDER BY ak.k, ak.created_at ASC`;
}

/**
 * E-321 — the owner of account `accountIdExpr` on IST calendar day `dateExpr`
 * (a date expression), from account_owner_history. NULL when nobody owned it.
 * Scalar subquery; requires E-321.
 */
export function accountOwnerOn(accountIdExpr: SQL, dateExpr: SQL): SQL {
    return sql`(SELECT ao_h.owner_user_id::text
                  FROM account_owner_history ao_h
                 WHERE ao_h.account_id = ${accountIdExpr}
                   AND (ao_h.effective_from AT TIME ZONE 'Asia/Kolkata')::date <= ${dateExpr}
                   AND (ao_h.effective_to IS NULL
                        OR (ao_h.effective_to AT TIME ZONE 'Asia/Kolkata')::date > ${dateExpr})
                 ORDER BY ao_h.effective_from DESC
                 LIMIT 1)`;
}
