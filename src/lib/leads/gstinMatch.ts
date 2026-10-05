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
 * ACCOUNTS TOO. Most dealers are onboarded directly, with no lead behind them,
 * so a lead-only rule left their invoices "not linked to a dealer" although the
 * dealer is a live account with that very GSTIN. dealerAccountByGstin() is the
 * same rule against `accounts` (activated dealers only, "PENDING" ignored),
 * used by revenueSource.matchedUnion() next to the lead match. An invoice is
 * LINKED when either matches. Per-person credit still follows the lead — an
 * account-only invoice credits someone only once the account has an owner.
 *
 * The TypeScript twin of GSTIN_KEY is normalizeGstin() in ./gstin.ts; keep
 * them in step.
 */
import { sql, type SQL } from "drizzle-orm";
import { ITARANG_GSTINS } from "./gstin";

/** A GSTIN as a join key: whitespace removed, upper-cased, '' -> NULL. */
export const GSTIN_KEY = (expr: SQL): SQL =>
    sql`NULLIF(upper(regexp_replace(COALESCE(${expr}, ''), '\\s', '', 'g')), '')`;

/**
 * ID 62: may this key be matched at all? The SQL twin of checkCustomerGstin()
 * in ./gstin.ts — the 15-character shape, the mod-36 check character, and not
 * one of iTarang's own registrations. Applied inside dealerLeadByGstin so a
 * GSTIN that fails never links an invoice to a dealer, whatever wrote it:
 * Zoho's gst_no, a row stored before the check existed, or an onboarding draft.
 * `key` must already be a GSTIN_KEY expression. scripts/verify-id62-gstin.ts
 * proves this agrees with the TypeScript on every GSTIN in the database.
 */
export function gstinKeyIsMatchable(key: SQL): SQL {
    const own = sql.join(
        ITARANG_GSTINS.map((g) => sql`${g}`),
        sql`, `,
    );
    return sql`(CASE WHEN ${key} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$'
                      AND ${key} NOT IN (${own})
        THEN (
            SELECT substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                          ((36 - (sum(gm_p / 36 + gm_p % 36) % 36)) % 36)::int + 1, 1)
              FROM (
                SELECT (strpos('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', substr(${key}, gm_i, 1)) - 1)
                       * (CASE WHEN gm_i % 2 = 1 THEN 1 ELSE 2 END) AS gm_p
                  FROM generate_series(1, 14) AS gm_i
              ) gm_digits
        ) = substr(${key}, 15, 1)
        ELSE FALSE END)`;
}

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
           AND ${gstinKeyIsMatchable(key)}
           AND (${GSTIN_KEY(sql`gm_dl.gstin`)} = ${key}
                OR ${GSTIN_KEY(sql`gm_app.gst_number`)} = ${key})
         ORDER BY (gm_dl.lead_status IN ('Converted', 'Won')) DESC,
                  gm_dl.closed_at DESC NULLS LAST,
                  gm_dl.created_at ASC
         LIMIT 1
    )`;
}

/**
 * `LATERAL (…)` yielding at most one row — acct_id, acct_name, acct_owner_id,
 * acct_city — for the activated dealer ACCOUNT whose GSTIN is `key` (an
 * already-normalised GSTIN_KEY expression). Use as
 * `LEFT JOIN ${dealerAccountByGstin(k)} ma ON TRUE`.
 *
 * Same set as src/lib/accounts/accountList.ts: an account with a `dealers`
 * row, its GSTIN not the "PENDING" placeholder. Several accounts with one
 * GSTIN (branches): the oldest wins — deterministic. The owner is read through
 * to_jsonb so a database without E-322 (no account_owner_id) still runs.
 */
export function dealerAccountByGstin(key: SQL): SQL {
    return sql`LATERAL (
        SELECT gm_a.id                                  AS acct_id,
               gm_a.business_entity_name                AS acct_name,
               to_jsonb(gm_a) ->> 'account_owner_id'    AS acct_owner_id,
               NULLIF(btrim(gm_a.city), '')             AS acct_city
          FROM accounts gm_a
         WHERE ${key} IS NOT NULL
           AND ${gstinKeyIsMatchable(key)}
           AND upper(btrim(gm_a.gstin)) <> 'PENDING'
           AND ${GSTIN_KEY(sql`gm_a.gstin`)} = ${key}
           AND EXISTS (SELECT 1 FROM dealers gm_d WHERE gm_d.dealer_id = gm_a.id)
         ORDER BY gm_a.created_at ASC, gm_a.id ASC
         LIMIT 1
    )`;
}
