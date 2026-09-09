/**
 * E-282/E-283/E-286/E-290/E-291 — the default loan product + NBFC an admin has
 * pinned, for a dealer or for WHERE THE CUSTOMER LIVES.
 *
 * `nbfc_loan_products.active_locations` decides which lenders CAN serve a
 * place. This decides which one actually gets offered. The two are deliberately
 * separate: coverage is the lender's own declaration, the default is iTarang's
 * commercial choice on top of it. So a pin never widens coverage — by the time
 * it is read, the BRE has already dropped every lender that cannot serve this
 * customer, and the pin only chooses among the ones that can.
 *
 * ONE LOCATION PAIR. `state` / `city` describe the CUSTOMER, matched against
 * `leads.state` / `leads.city` (E-291). They were the dealer's own registered
 * address between E-286 and E-290; that leg is gone, because a default is
 * written about a market ("customers in Kolkata get product X"), not about
 * where the shop happens to be registered.
 *
 * A rule is exactly ONE OF THREE KINDS, and they form a ladder with no ties:
 *
 *   dealer_code  state        city      meaning
 *   -----------  -----------  --------  -------------------------------------
 *   ACC-…-971    NULL         NULL      that dealer, whoever the customer is
 *   NULL         West Bengal  Kolkata   customers in Kolkata
 *   NULL         West Bengal  NULL      customers anywhere in West Bengal
 *
 * Ordering is that ladder and nothing else: THE MOST SPECIFIC RULE WINS —
 * dealer, then city, then state. There is no priority number; the admin does
 * not rank rules, specificity does it for them. `_active_key_v3` allows only
 * one active row per scope, so two rules can never tie; `id DESC` is a
 * total-order guard for legacy rows that predate this shape.
 *
 * The caller walks the returned list in order and takes the first rule that
 * survived the BRE, so a pin that does not fit this customer falls through to
 * the next one rather than dead-ending them.
 *
 * `customer_state` / `customer_city` are RETIRED (E-289, removed by E-290) and
 * NOT the columns this reads — E-291 put the customer back on `state`/`city`
 * rather than resurrecting them, so the five-column unique key keeps working
 * unchanged. Any row that still declares one is excluded outright below rather
 * than being reinterpreted, which is what makes this correct on a database
 * where E-290's cleanup has not been run.
 *
 * Every read is guarded and returns `[]` on failure. That is what keeps the
 * feature skippable at deploy: on a database without these columns, Step 4
 * keeps showing the full BRE-matched list rather than failing outright.
 * E-282 and E-283 must be applied together — see the E-283 header. E-286 is
 * comments only. E-290 and E-291 are data-only and independently skippable.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export interface DefaultProductRule {
  id: number;
  /** null = applies to every dealer, i.e. the rule is location-scoped. */
  dealerCode: string | null;
  /** The CUSTOMER's state. null = the rule is dealer-scoped instead. */
  state: string | null;
  /** The CUSTOMER's city. null = every city of `state`. */
  city: string | null;
  nbfcId: number;
  loanProductId: number;
}

/** What a lead offers a rule to match on: its dealer, and where it lives. */
export interface DefaultProductScope {
  /** `leads.dealer_id`, which IS `accounts.id` — the dealer CODE. */
  dealerCode: string | null | undefined;
  /** `leads.state` — where the CUSTOMER lives. */
  customerState: string | null | undefined;
  /** `leads.city` — where the CUSTOMER lives. */
  customerCity: string | null | undefined;
}

type Row = {
  id: number;
  dealer_code: string | null;
  state: string | null;
  city: string | null;
  nbfc_id: number;
  loan_product_id: number;
};

/**
 * Every pinned rule that applies to this lead, most-specific first.
 *
 * Returns `[]` when nothing is configured, when the lead offers neither a
 * dealer nor a state to match on, or when the table/columns do not exist yet.
 *
 * Matched case- and whitespace-insensitively, which matters because a lead's
 * city is typed during capture (and arrives over WhatsApp as free text) and
 * need not be spelled exactly as the admin form's picker spells it.
 */
export async function resolveDefaultProductRules(
  scope: DefaultProductScope,
): Promise<DefaultProductRule[]> {
  const dealerKey = norm(scope.dealerCode);
  const stateKey = norm(scope.customerState);
  const cityKey = norm(scope.customerCity);

  // Neither leg has anything to match on — no rule of any kind could fire.
  if (!dealerKey && !stateKey) return [];

  try {
    // An unknown leg is compared as '' rather than special-cased: no stored
    // scope normalises to the empty string, so a rule that declares that leg
    // simply cannot match, which is exactly the intent. A rule that leaves the
    // leg NULL is unscoped there and still matches.
    //
    // `false` sorts before `true` in Postgres, so each `IS NULL` term puts the
    // more specific row first: dealer, then city, then state. `id DESC` last
    // makes the order total and stable rather than leaving it to the planner.
    const rows = await db.execute<Row>(sql`
      SELECT r.id, r.dealer_code, r.state, r.city,
             r.nbfc_id, r.loan_product_id
        FROM city_default_loan_products r
       WHERE r.is_active
         AND r.customer_state IS NULL
         AND r.customer_city IS NULL
         AND (
           r.dealer_code IS NULL
           OR lower(btrim(r.dealer_code)) = ${dealerKey}
         )
         AND (
           r.state IS NULL
           OR lower(btrim(r.state)) = ${stateKey}
         )
         AND (
           r.city IS NULL
           OR lower(btrim(r.city)) = ${cityKey}
         )
       ORDER BY (r.dealer_code IS NULL),
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
    }));
  } catch (err) {
    // Almost always a missing relation or column on an environment where
    // E-282/E-283 have not been applied. Never break Step 4 over it.
    console.error("[city-default-product] lookup failed:", err);
    return [];
  }
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
