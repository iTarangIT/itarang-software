------------------------------------------------------------------------------
-- E-291: the location leg of a default loan product rule is the CUSTOMER's
-- again — `state` / `city` are matched against leads.state / leads.city.
--
-- WHAT CHANGES. Only the MEANING of two existing columns, and only for rules
-- that declare a location:
--
--   dealer_code  state        city      before (E-286)          after (E-291)
--   -----------  -----------  --------  ----------------------  ---------------------
--   ACC-…-971    NULL         NULL      that dealer             that dealer  (same)
--   NULL         West Bengal  Kolkata   dealers IN Kolkata      CUSTOMERS in Kolkata
--   NULL         West Bengal  NULL      dealers in West Bengal  CUSTOMERS in WB
--
-- The three kinds, the dealer > city > state ladder, and the absence of a
-- priority number all stay exactly as E-290 left them.
--
-- WHY. E-286 moved the location onto the dealer's own `accounts` address and
-- E-290 retired the customer leg outright, on the reasoning that the BRE has
-- already applied nbfc_loan_products.active_locations to the lead before a pin
-- is read, so a rule never has to restate where the customer lives. That is
-- still true and is exactly why this is safe — a pin cannot widen coverage,
-- only choose among the lenders that already serve this customer. But it is
-- the wrong DEFAULT: the business writes "customers in Kolkata are offered
-- product X", a statement about a market, not about where a shop is
-- registered. Two further things made the dealer reading unworkable in
-- practice: dealer addresses are sparse on `accounts` (a state rule matched
-- almost nothing), and a dealer that sells across a state line silently
-- changed which rule applied to every one of its customers.
--
-- WHY NOT customer_state / customer_city. Those columns exist (E-289) and are
-- retired (E-290). Reviving them would put the meaning back on a pair that is
-- coalesced to '' inside city_default_loan_products_active_key_v3, forcing a
-- _v4 unique index and re-opening the v2/v3 index-resurrection problem E-283
-- and E-289 both had to guard against. Moving the meaning onto `state`/`city`
-- instead needs no index change at all: with the customer pair still always
-- NULL, the five-column key keeps behaving exactly as a three-column key.
-- They stay NULL, still excluded on read, and still just history.
--
-- DATA ONLY — NO DDL. Nothing is added, dropped, or narrowed.
--
-- THE ONE THING THAT NEEDS DOING. An EXISTING location-scoped rule was written
-- to mean a DEALER location. Left active it would silently start applying to
-- CUSTOMERS in that place — a different set of leads, chosen by nobody. So
-- every such rule is soft-deactivated here, the same way DELETE on this table
-- already works, and the admin re-creates the ones they still want under the
-- new meaning. Dealer-scoped rules (state IS NULL AND city IS NULL) are
-- untouched: their meaning has not changed.
--
-- IDEMPOTENT, AND SAFE TO RUN LATE. The cutoff is a fixed timestamp, not
-- "everything location-scoped", so re-running this cannot deactivate rules the
-- admin creates AFTER it — those are already written under the new meaning.
-- The cutoff is the day the E-291 code shipped; every location rule older than
-- that predates it by definition, on any environment, whenever this is applied.
--
-- SAFE WITHOUT THIS FILE, in the sense that nothing breaks: the resolver reads
-- `state`/`city` against the lead either way. The cost of skipping it is
-- precisely the silent reinterpretation described above, so apply it with the
-- deploy.
------------------------------------------------------------------------------

DO $do$
DECLARE
  -- The day E-291 shipped. Any active location rule created before this was
  -- written under the E-286 dealer-location meaning.
  e291_cutoff CONSTANT timestamptz := TIMESTAMPTZ '2026-09-08 00:00:00+05:30';
  retired_count integer;
BEGIN

  UPDATE city_default_loan_products
     SET is_active  = false,
         updated_at = now()
   WHERE is_active
     AND (state IS NOT NULL OR city IS NOT NULL)
     AND created_at < e291_cutoff;

  GET DIAGNOSTICS retired_count = ROW_COUNT;
  IF retired_count > 0 THEN
    RAISE NOTICE 'E-291: deactivated % location rule(s) written under the DEALER-location meaning — re-create them if they are still wanted, now that state/city mean the CUSTOMER''s', retired_count;
  ELSE
    RAISE NOTICE 'E-291: no pre-existing location rules to retire';
  END IF;

  COMMENT ON COLUMN city_default_loan_products.state IS
    'E-291: the CUSTOMER''s leads.state — where the applicant lives, NOT the dealer (which is what E-286 to E-290 meant here). NULL = the rule is dealer-scoped instead.';

  COMMENT ON COLUMN city_default_loan_products.city IS
    'E-291: the CUSTOMER''s leads.city. NULL = every city within state.';

  COMMENT ON COLUMN city_default_loan_products.customer_state IS
    'E-289, RETIRED BY E-290, NOT revived by E-291 — the customer location lives on `state`/`city` instead, so the _v3 unique key needs no _v4. Kept for history; always NULL on new rows. A row that still declares one is EXCLUDED by the resolver, never reinterpreted as "any customer".';

  COMMENT ON TABLE city_default_loan_products IS
    'E-282/E-283/E-286/E-290/E-291: pins one NBFC + loan product as the default offered to a dealer, or to a CUSTOMER LOCATION (leads.state / leads.city). A rule is exactly one of three kinds — dealer, customer city, customer state — and the MOST SPECIFIC WINS, in that order. Applied by applyPinnedDefault() to the BRE hits: a pinned product that does not independently match is skipped and the next rule (or normal matching) is used, so a pin can never widen a lender''s coverage.';

EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip E-291: city_default_loan_products does not exist (nothing to reinterpret)';
END;
$do$;
