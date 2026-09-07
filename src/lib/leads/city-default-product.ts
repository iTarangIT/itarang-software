/**
 * E-282/E-283/E-286/E-289 — the default loan product + NBFC an admin has
 * pinned, for a dealer, for the LOCATION OF THE DEALER, for the LOCATION OF THE
 * CUSTOMER, or any combination.
 *
 * `nbfc_loan_products.active_locations` decides which lenders CAN serve a
 * place. This decides which one actually gets offered. The two are deliberately
 * separate: coverage is the lender's own declaration, the default is iTarang's
 * commercial choice on top of it.
 *
 * TWO LOCATION PAIRS. `state` / `city` describe the DEALER, read from
 * `accounts.state` / `accounts.city` — its own registered address (E-286,
 * because "dealers in Maharashtra sell iTarang F1" is the rule the business
 * actually writes). `customer_state` / `customer_city` describe the CUSTOMER,
 * read straight off `leads.state` / `leads.city` (E-289, because "customers in
 * Pune are financed by iTarang F1, whichever dealer they walked into" is the
 * other rule the business writes). They are independent: a rule may declare
 * either pair, both, or neither.
 *
 * Every scoping column is nullable and NULL means "any", so a rule matches a
 * lead when every column it actually declares matches:
 *
 *   dealer_code  state      city    customer_state  customer_city  meaning
 *   -----------  ---------  ------  --------------  -------------  ----------
 *   ACC-…-971    NULL       NULL    NULL            NULL           that dealer, wherever it is
 *   ACC-…-971    Delhi      Delhi   NULL            NULL           that dealer, and only while it is in Delhi
 *   NULL         Delhi      Delhi   NULL            NULL           every dealer located in Delhi
 *   NULL         Telangana  NULL    NULL            NULL           every dealer located in Telangana
 *   NULL         NULL       NULL    Maharashtra     Pune           every customer living in Pune
 *   NULL         NULL       NULL    Maharashtra     NULL           every customer living in Maharashtra
 *   ACC-…-971    NULL       NULL    Maharashtra     Pune           that dealer's Pune customers
 *
 * A lead whose location is still the WhatsApp placeholder "Unknown" matches no
 * rule that DECLARES a customer location — it falls through to the next rule
 * and then to the full matched list. `reresolveLeadLocationFromDocs()` patches
 * the placeholder from the Aadhaar/address proof before the WhatsApp Step-4
 * match asks, so that is a fallback rather than the normal path.
 *
 * Ordering is the admin's `priority` first — they decide, rather than a
 * hard-coded rule deciding for them. Specificity only breaks ties, and since
 * E-289 it breaks them by COUNT first: the rule that pins down more of the five
 * scoping columns is checked first, and only then the old ladder (dealer,
 * customer city, customer state, dealer city, dealer state, newest). Counting
 * first is what keeps "dealer X + customers in Pune" ahead of both "dealer X"
 * and "customers in Pune" without having to rank the two pairs against each
 * other. The caller walks the returned list in order and takes the first rule
 * that survived the BRE, so a pin that does not fit this customer falls through
 * to the next one rather than being abandoned.
 *
 * Every read is guarded and returns `[]` on failure. That is what keeps the
 * feature skippable at deploy: on a database without these columns, Step 4
 * keeps showing the full BRE-matched list rather than failing outright.
 * E-282 and E-283 must be applied together — see the E-283 header. E-286 is
 * comments only. E-289 is additive and independently skippable.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isUnresolvedLocation } from "@/lib/leads/resolve-location";

export interface DefaultProductRule {
  id: number;
  /** null = applies to every dealer. */
  dealerCode: string | null;
  /** null = applies to a dealer in any state. */
  state: string | null;
  /** null = applies to a dealer in any city of `state`. */
  city: string | null;
  /** null = applies to a customer living in any state. */
  customerState: string | null;
  /** null = applies to a customer living in any city of `customerState`. */
  customerCity: string | null;
  nbfcId: number;
  loanProductId: number;
  priority: number;
}

type Row = {
  id: number;
  dealer_code: string | null;
  state: string | null;
  city: string | null;
  customer_state: string | null;
  customer_city: string | null;
  nbfc_id: number;
  loan_product_id: number;
  priority: number;
};

/** The lead's own address, for the customer leg of the match (E-289). */
export interface CustomerLocation {
  state?: string | null;
  city?: string | null;
}

/**
 * Every pinned rule that applies to this lead, most-preferred first.
 *
 * Takes the lead's dealer CODE (`leads.dealer_id`, which IS `accounts.id`) —
 * which identifies both the dealer leg and the dealer-location leg, because the
 * location those compare against is that dealer's own — and, since E-289, the
 * lead's own `state`/`city` for the customer leg.
 *
 * Returns `[]` when nothing is configured, when the lead has no dealer, or when
 * the table/columns do not exist yet.
 *
 * Matched case- and whitespace-insensitively. That matters most for the dealer
 * legs: a dealer's address is captured during onboarding and may not be spelled
 * exactly as the admin form spells it. The customer legs are both written from
 * `country-state-city`, so they agree already — but they are normalised the
 * same way rather than relying on it.
 */
export async function resolveDefaultProductRules(
  dealerCode: string | null | undefined,
  customer?: CustomerLocation,
): Promise<DefaultProductRule[]> {
  const dealerKey = norm(dealerCode);

  // No dealer, no dealer location — nothing any rule could match on.
  if (!dealerKey) return [];

  // An unread WhatsApp address is no address at all. Normalised to "" here,
  // which matches no rule that declares a customer location, rather than
  // matching a literal city named after the placeholder.
  const customerStateKey = isUnresolvedLocation(customer?.state)
    ? ""
    : norm(customer?.state);
  const customerCityKey = isUnresolvedLocation(customer?.city)
    ? ""
    : norm(customer?.city);

  try {
    // The LEFT JOIN is on a constant (a primary-key lookup independent of `r`),
    // so it contributes exactly one row — or NULLs when the dealer has no
    // account, in which case only rules that declare no dealer location can
    // match.
    //
    // `false` sorts before `true` in Postgres, so each `IS NULL` term puts the
    // more specific row first. The count above them makes an overall-more-
    // specific rule win outright; the ladder only settles rules that declare
    // the same NUMBER of columns. `id DESC` last makes the order total and
    // stable, so two rules an admin left at the same priority still resolve
    // deterministically rather than by whatever the planner returns.
    const rows = await db.execute<Row>(sql`
      SELECT r.id, r.dealer_code, r.state, r.city,
             r.customer_state, r.customer_city,
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
         AND (
           r.customer_state IS NULL
           OR lower(btrim(r.customer_state)) = ${customerStateKey}
         )
         AND (
           r.customer_city IS NULL
           OR lower(btrim(r.customer_city)) = ${customerCityKey}
         )
       ORDER BY r.priority DESC,
                ( (r.dealer_code    IS NOT NULL)::int
                + (r.customer_city  IS NOT NULL)::int
                + (r.customer_state IS NOT NULL)::int
                + (r.city           IS NOT NULL)::int
                + (r.state          IS NOT NULL)::int ) DESC,
                (r.dealer_code IS NULL),
                (r.customer_city IS NULL),
                (r.customer_state IS NULL),
                (r.city IS NULL),
                (r.state IS NULL),
                r.id DESC
    `);

    return rows.map((row) => ({
      id: Number(row.id),
      dealerCode: row.dealer_code,
      state: row.state,
      city: row.city,
      customerState: row.customer_state,
      customerCity: row.customer_city,
      nbfcId: Number(row.nbfc_id),
      loanProductId: Number(row.loan_product_id),
      priority: Number(row.priority),
    }));
  } catch (err) {
    // Almost always a missing relation or column on an environment where
    // E-282/E-283/E-289 have not been applied. Never break Step 4 over it.
    console.error("[city-default-product] lookup failed:", err);
    return [];
  }
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
