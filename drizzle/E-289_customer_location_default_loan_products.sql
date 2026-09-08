------------------------------------------------------------------------------
-- E-289: pin a default loan product by where the CUSTOMER lives, too.
--
-- PROBLEM. E-286 settled that city_default_loan_products.state / .city describe
-- the DEALER's own registered address (accounts.state / accounts.city), because
-- the commercial arrangement is with the dealer: "dealers in Maharashtra sell
-- iTarang F1" is the rule the business actually writes. That removed the only
-- way to express the other, equally real rule: "customers in Pune are financed
-- by iTarang F1", whichever dealer they walked into.
--
-- nbfc_loan_products.active_locations cannot stand in for it. That column is
-- the LENDER's declaration of where it CAN serve, evaluated by the BRE before
-- any pin is consulted. This is iTarang's commercial choice of which covered
-- lender IS offered. Coverage and default stay separate, exactly as the E-282
-- header says.
--
-- SHAPE. Two more nullable scoping columns beside the dealer pair. NULL still
-- means "any", so a rule matches a lead when every column it actually declares
-- matches, and the two pairs are independent — a rule may use either, both, or
-- neither:
--
--   dealer_code  state     city    customer_state  customer_city   meaning
--   -----------  --------  ------  --------------  --------------  -----------
--   ACC-…-971    NULL      NULL    NULL            NULL            that dealer, wherever it is, whoever the customer is
--   NULL         Maharash… Nashik  NULL            NULL            every dealer registered in Nashik            (E-286)
--   NULL         NULL      NULL    Maharashtra     Pune            every customer living in Pune                (E-289)
--   ACC-…-971    NULL      NULL    Maharashtra     Pune            that dealer's Pune customers                 (E-289)
--
-- The customer pair is matched against leads.state / leads.city — the SAME
-- columns the BRE's active_locations rule reads, spelled by the
-- `country-state-city` package because that is what the Step 1 form and the
-- admin loan-product geography picker both write. The dealer pair keeps its
-- lower(btrim(...)) comparison against accounts, whose address is free text
-- captured at onboarding.
--
-- A lead whose location is still the WhatsApp placeholder 'Unknown' matches no
-- rule that DECLARES a customer location — it simply falls through to the next
-- rule, and then to the full BRE-matched list. resolveLeadLocation() patches
-- the placeholder from the Aadhaar/address proof before Step 4 asks, so this is
-- a fallback rather than the normal path.
--
-- PRECEDENCE (changed). `priority` DESC still wins first — the admin decides.
-- The tie-break is now "the rule that pins down MORE of the five scoping
-- columns is checked first", and only then the old ladder: dealer, customer
-- city, customer state, dealer city, dealer state, newest id. Counting first is
-- what keeps "dealer X + customers in Pune" ahead of both "dealer X" and
-- "customers in Pune" without having to rank the two pairs against each other.
-- With no customer-location rules configured the resulting order is identical
-- to E-283's.
--
-- NO BACKFILL. Both columns arrive NULL = "any customer", so every rule already
-- in the table keeps its exact current behaviour and no row is rewritten.
--
-- RE-RUN ORDER. E-282 and E-283 were both amended when this file shipped so
-- that each guards its own (now superseded) unique key on the absence of the
-- newer one — the trick E-282 already played for E-283. So the four files can
-- be re-run in any order, any number of times, without a narrower key coming
-- back to reject rules that differ only in the customer they target. Anyone
-- carrying an OLD copy of E-283 should not re-apply it after this file; if
-- they do, re-run this one, which drops v2 again.
--
-- Strictly additive and idempotent; re-running is a no-op.
------------------------------------------------------------------------------

DO $do$
BEGIN

  -- leads.state / leads.city. NULL = the rule is not customer-scoped and
  -- applies to every customer (E-286's behaviour). Loose values, like the
  -- dealer pair: a rule may legitimately be written ahead of the first lead
  -- from that city.
  ALTER TABLE city_default_loan_products
    ADD COLUMN IF NOT EXISTS customer_state varchar(100);

  ALTER TABLE city_default_loan_products
    ADD COLUMN IF NOT EXISTS customer_city varchar(100);

  -- The E-283 key allowed one ACTIVE row per (dealer_code, state, city), which
  -- would now collide two rules that differ only in the customer they target.
  -- Widen it across all five scoping columns. Strictly WIDER than the index it
  -- replaces — every existing row has both new columns NULL and was already
  -- unique on the first three — so the rebuild cannot fail on live data.
  DROP INDEX IF EXISTS city_default_loan_products_active_key_v2;
  CREATE UNIQUE INDEX IF NOT EXISTS city_default_loan_products_active_key_v3
    ON city_default_loan_products (
      lower(coalesce(dealer_code, '')),
      lower(coalesce(state, '')),
      lower(coalesce(city, '')),
      lower(coalesce(customer_state, '')),
      lower(coalesce(customer_city, ''))
    ) WHERE is_active;

  -- resolveDefaultProductRules() filters on is_active and matches the dealer
  -- leg OR the customer leg; the state and dealer indexes from E-282/E-283
  -- stay, this covers the customer leg.
  CREATE INDEX IF NOT EXISTS city_default_loan_products_active_customer_state_idx
    ON city_default_loan_products (lower(coalesce(customer_state, ''))) WHERE is_active;

  COMMENT ON COLUMN city_default_loan_products.customer_state IS
    'E-289: the CUSTOMER''s leads.state — where the applicant lives, not the dealer. NULL = the rule is not customer-scoped and applies to every customer.';

  COMMENT ON COLUMN city_default_loan_products.customer_city IS
    'E-289: the CUSTOMER''s leads.city. NULL = every customer city within customer_state (or every customer, when customer_state is NULL too).';

  COMMENT ON COLUMN city_default_loan_products.state IS
    'E-286: the DEALER''s accounts.state — where the dealer is registered, NOT the customer (see customer_state, E-289). NULL = the rule declares no dealer location.';

  COMMENT ON COLUMN city_default_loan_products.city IS
    'E-286: the DEALER''s accounts.city — NOT the customer (see customer_city, E-289). NULL = every dealer city within state.';

  COMMENT ON COLUMN city_default_loan_products.priority IS
    'E-283/E-289: highest wins. On a tie the rule declaring MORE of the five scoping columns is checked first, then dealer, customer city, customer state, dealer city, dealer state, newest.';

  COMMENT ON TABLE city_default_loan_products IS
    'E-282/E-283/E-286/E-289: pins one NBFC + loan product as the default offered for a dealer, a DEALER location, a CUSTOMER location, or any combination. Every scoping column is nullable and NULL means "any". Ordered by priority DESC then specificity, and applied by applyPinnedDefault() to the BRE hits — a pinned product that does not independently match is skipped and the next rule (or normal matching) is used.';

EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-289: city_default_loan_products does not exist (apply E-282 + E-283 first)';
END;
$do$;
