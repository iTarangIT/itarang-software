/**
 * E-280/E-281/E-284 — the default loan product + NBFC an admin has pinned, for
 * a dealer, for the LOCATION OF THE DEALER, or both.
 *
 * `nbfc_loan_products.active_locations` decides which lenders CAN serve a
 * place. This decides which one actually gets offered. The two are deliberately
 * separate: coverage is the lender's own declaration, the default is iTarang's
 * commercial choice on top of it.
 *
 * WHOSE LOCATION (E-284). `state` / `city` describe the DEALER, read from
 * `accounts.state` / `accounts.city` — the dealer's own registered address —
 * NOT the customer's. E-280/E-281 matched the customer's `leads.state` /
 * `leads.city`; that was changed because the commercial arrangement is with the
 * dealer, so "dealers in Maharashtra sell iTarang F1" is the rule the business
 * actually writes. A consequence worth knowing: a lead with no dealer can no
 * longer match any rule, because there is no location to match on.
 *
 * Every scoping column is nullable and NULL means "any", so a rule matches a
 * lead when every column it actually declares matches:
 *
 *   dealer_code  state       city     meaning
 *   -----------  ----------  -------  ---------------------------------------
 *   ACC-…-971    NULL        NULL     that dealer, wherever it is
 *   ACC-…-971    Delhi       Delhi    that dealer, and only while it is in Delhi
 *   NULL         Delhi       Delhi    every dealer located in Delhi
 *   NULL         Telangana   NULL     every dealer located in Telangana
 *
 * Ordering is the admin's `priority` first — they decide, rather than a
 * hard-coded rule deciding for them — and specificity only breaks ties. The
 * caller walks the returned list in order and takes the first rule that
 * survived the BRE, so a pin that does not fit this customer falls through to
 * the next one rather than being abandoned.
 *
 * Every read is guarded and returns `[]` on failure. That is what keeps the
 * feature skippable at deploy: on a database without these columns, Step 4
 * keeps showing the full BRE-matched list rather than failing outright.
 * E-280 and E-281 must be applied together — see the E-281 header. E-284 is
 * comments only and changes no data.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export interface DefaultProductRule {
  id: number;
  /** null = applies to every dealer. */
  dealerCode: string | null;
  /** null = applies to a dealer in any state. */
  state: string | null;
  /** null = applies to a dealer in any city of `state`. */
  city: string | null;
  nbfcId: number;
  loanProductId: number;
  priority: number;
}

type Row = {
  id: number;
  dealer_code: string | null;
  state: string | null;
  city: string | null;
  nbfc_id: number;
  loan_product_id: number;
  priority: number;
};

/**
 * Every pinned rule that applies to this lead, most-preferred first.
 *
 * Takes the lead's dealer CODE (`leads.dealer_id`, which IS `accounts.id`) and
 * nothing else: the dealer identifies both legs of the match, because the
 * location a rule compares against is that dealer's own.
 *
 * Returns `[]` when nothing is configured, when the lead has no dealer, or when
 * the table/columns do not exist yet.
 *
 * Matched case- and whitespace-insensitively, which matters more here than it
 * did for customer locations: a dealer's address is captured during onboarding
 * and may not be spelled exactly as the admin form spells it.
 */
export async function resolveDefaultProductRules(
  dealerCode: string | null | undefined,
): Promise<DefaultProductRule[]> {
  const dealerKey = norm(dealerCode);

  // No dealer, no dealer location — nothing any rule could match on.
  if (!dealerKey) return [];

  try {
    // The LEFT JOIN is on a constant (a primary-key lookup independent of `r`),
    // so it contributes exactly one row — or NULLs when the dealer has no
    // account, in which case only rules that declare no location can match.
    //
    // `false` sorts before `true` in Postgres, so each `IS NULL` term puts the
    // more specific row first. `id DESC` last makes the order total and
    // stable, so two rules an admin left at the same priority still resolve
    // deterministically rather than by whatever the planner returns.
    const rows = await db.execute<Row>(sql`
      SELECT r.id, r.dealer_code, r.state, r.city,
             r.nbfc_id, r.loan_product_id, r.priority
        FROM city_default_loan_products r
        LEFT JOIN accounts a ON a.id = ${dealerCode}
       WHERE r.is_active
         AND (
           r.dealer_code IS NULL
           OR lower(btrim(r.dealer_code)) = ${dealerKey}
         )
         AND (
           r.state IS NULL
           OR lower(btrim(r.state)) = lower(btrim(a.state))
         )
         AND (
           r.city IS NULL
           OR lower(btrim(r.city)) = lower(btrim(a.city))
         )
       ORDER BY r.priority DESC,
                (r.dealer_code IS NULL),
                (r.city IS NULL),
                (r.state IS NULL),
                r.id DESC
    `);

    return rows.map((row) => ({
      id: Number(row.id),
      dealerCode: row.dealer_code,
      state: row.state,
      city: row.city,
      nbfcId: Number(row.nbfc_id),
      loanProductId: Number(row.loan_product_id),
      priority: Number(row.priority),
    }));
  } catch (err) {
    // Almost always a missing relation or column on an environment where
    // E-280/E-281 have not been applied. Never break Step 4 over it.
    console.error("[city-default-product] lookup failed:", err);
    return [];
  }
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
