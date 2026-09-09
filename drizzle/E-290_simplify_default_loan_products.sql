------------------------------------------------------------------------------
-- E-290: simplify the default loan product rules — retire `priority` and the
-- customer-location leg.
--
-- PROBLEM. Settings → Loan Product had grown two competing ordering systems on
-- top of five scoping columns. An admin set a `priority` NUMBER (E-283), and
-- then a specificity ladder broke ties by counting how many of the five columns
-- a rule declared, and then a fixed order settled THAT (E-289). The screen
-- needed four lines of prose to explain which rule would win, and the two
-- location pairs — the DEALER's (accounts) and the CUSTOMER's (leads) — looked
-- identical in the form while being sourced from completely different places.
--
-- SHAPE. A rule is now exactly ONE OF THREE KINDS, and the most specific one
-- wins:
--
--   dealer_code  state        city     meaning
--   -----------  -----------  -------  ------------------------------------
--   ACC-…-971    NULL         NULL     that dealer, wherever it is
--   NULL         Maharashtra  Nashik   every dealer located in Nashik
--   NULL         Maharashtra  NULL     every dealer located in Maharashtra
--
-- ORDER: dealer, then city, then state. No number to set, no tie to break —
-- _active_key_v3 already allows only one active row per scope.
--
-- WHY THE CUSTOMER LEG GOES. It was largely restating coverage.
-- nbfc_loan_products.active_locations is the LENDER's declaration of where it
-- can serve, and the BRE applies it against leads.state / leads.city BEFORE any
-- pin is consulted — so by the time a rule is read, every remaining lender
-- already serves this customer. The pin only has to choose among them, and the
-- dealer is who the commercial arrangement is actually with.
--
-- DATA ONLY — NO DDL. Nothing is dropped: `priority`, `customer_state` and
-- `customer_city` stay on the table as history and so this is reversible
-- without a destructive migration. They are written NULL/0 from now on and
-- ignored on read.
--
-- THE UNIQUE KEY IS DELIBERATELY UNTOUCHED. city_default_loan_products_active_
-- key_v3 coalesces the two customer columns to '', so with both always NULL it
-- keeps behaving exactly as a three-column key would. Introducing a _v4 would
-- re-open the v2/v3 resurrection problem E-283 and E-289 had to guard against,
-- for no gain.
--
-- SAFE WITHOUT THIS FILE. resolveDefaultProductRules() and the settings GET
-- both filter on `customer_state IS NULL AND customer_city IS NULL`, so a
-- customer-scoped row is inert and hidden whether or not this ran — it is
-- never reinterpreted as "applies to everyone". This migration is the cleanup
-- that stops such a row sitting active forever with no UI to explain it.
--
-- IDEMPOTENT: the UPDATE matches nothing on a second run. Skips cleanly on a
-- database that never received E-282/E-283.
------------------------------------------------------------------------------

DO $do$
DECLARE
  retired_count integer;
  priority_count integer;
BEGIN

  -- Customer-scoped rules (E-289) can no longer be created or displayed.
  -- Soft-deactivated, the same way DELETE on this table already works, so the
  -- rows survive as history.
  UPDATE city_default_loan_products
     SET is_active  = false,
         updated_at = now()
   WHERE is_active
     AND (customer_state IS NOT NULL OR customer_city IS NOT NULL);

  GET DIAGNOSTICS retired_count = ROW_COUNT;
  IF retired_count > 0 THEN
    RAISE NOTICE 'E-290: deactivated % customer-scoped rule(s) — the customer-location leg is retired', retired_count;
  END IF;

  -- `priority` is no longer read. Left in place rather than zeroed (it is
  -- history now), but worth saying out loud if any surviving rule leaned on it,
  -- because that rule's position in the order may have changed.
  SELECT count(*) INTO priority_count
    FROM city_default_loan_products
   WHERE is_active AND priority <> 0;

  IF priority_count > 0 THEN
    RAISE NOTICE 'E-290: % active rule(s) still carry a non-zero priority; it is now IGNORED — ordering is dealer, then city, then state', priority_count;
  END IF;

  COMMENT ON COLUMN city_default_loan_products.priority IS
    'E-283, RETIRED BY E-290: an admin-chosen tie-break, replaced by the dealer/city/state ladder. Kept for history; always 0 on new rows and ignored on read.';

  COMMENT ON COLUMN city_default_loan_products.customer_state IS
    'E-289, RETIRED BY E-290: the CUSTOMER''s leads.state. Kept for history; always NULL on new rows. A row that still declares one is EXCLUDED by the resolver, never reinterpreted as "any customer".';

  COMMENT ON COLUMN city_default_loan_products.customer_city IS
    'E-289, RETIRED BY E-290: the CUSTOMER''s leads.city. Kept for history; always NULL on new rows. See customer_state.';

  COMMENT ON COLUMN city_default_loan_products.state IS
    'E-286: the DEALER''s accounts.state — where the dealer is registered, NOT the customer. NULL = the rule is dealer-scoped instead.';

  COMMENT ON COLUMN city_default_loan_products.city IS
    'E-286: the DEALER''s accounts.city. NULL = every dealer city within state.';

  COMMENT ON TABLE city_default_loan_products IS
    'E-282/E-283/E-286/E-290: pins one NBFC + loan product as the default offered for a dealer, or for a DEALER location. A rule is exactly one of three kinds — dealer, dealer city, dealer state — and the MOST SPECIFIC WINS, in that order. Applied by applyPinnedDefault() to the BRE hits: a pinned product that does not independently match is skipped and the next rule (or normal matching) is used.';

EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-290: city_default_loan_products does not exist (nothing to clean up)';
END;
$do$;
