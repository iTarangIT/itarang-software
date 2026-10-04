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
 * E-321 (tracker IDs 68, 69 / handover P1-5) — the ACCOUNT an invoice belongs
 * to, and who owned that account ON THE INVOICE DATE.
 *
 * `LATERAL (…)` yielding at most one row:
 *   account_id, account_name,
 *   account_owner_id   — owner whose account_owner_history window holds the
 *                        invoice date (IST calendar day); NULL = nobody owned it
 *   link_kind          — 'linked' | 'not_dealer' when a person decided this
 *                        invoice by hand (invoice_account_links), else NULL
 *
 * Match order: a hand link on (source, invoice_id) wins; otherwise the
 * account whose primary GSTIN or any account_gstins alias equals `key`.
 * Oldest account first on a tie (branches share their parent's row anyway).
 *
 * Past revenue never moves on reassignment: the owner is read from the
 * window in force on `dateExpr`, not from account_ownership's current owner.
 * Requires E-321 — callers gate on hasAccountOwnershipTables().
 */
export function dealerAccountByGstin(
    key: SQL,
    dateExpr: SQL,
    sourceExpr: SQL,
    invoiceIdExpr: SQL,
): SQL {
    return sql`LATERAL (
        SELECT ga_link.kind                                         AS link_kind,
               ga_acc.account_id,
               ga_acc.account_name,
               (SELECT ga_h.owner_user_id
                  FROM account_owner_history ga_h
                 WHERE ga_h.account_id = ga_acc.account_id
                   AND (ga_h.effective_from AT TIME ZONE 'Asia/Kolkata')::date <= ${dateExpr}
                   AND (ga_h.effective_to IS NULL
                        OR (ga_h.effective_to AT TIME ZONE 'Asia/Kolkata')::date > ${dateExpr})
                 ORDER BY ga_h.effective_from DESC
                 LIMIT 1)                                           AS account_owner_id
          FROM (SELECT 1) ga_one
          LEFT JOIN invoice_account_links ga_link
                 ON ga_link.source = ${sourceExpr}
                AND ga_link.invoice_id = ${invoiceIdExpr}
          LEFT JOIN LATERAL (
                SELECT ga_a.id                    AS account_id,
                       ga_a.business_entity_name  AS account_name
                  FROM accounts ga_a
                 WHERE (ga_link.kind = 'linked' AND ga_a.id = ga_link.account_id)
                    OR (ga_link.kind IS NULL AND ${key} IS NOT NULL AND (
                            ${GSTIN_KEY(sql`ga_a.gstin`)} = ${key}
                         OR EXISTS (SELECT 1 FROM account_gstins ga_g
                                     WHERE ga_g.account_id = ga_a.id
                                       AND ga_g.gstin = ${key})))
                 ORDER BY ga_a.created_at ASC
                 LIMIT 1
          ) ga_acc ON TRUE
    )`;
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
