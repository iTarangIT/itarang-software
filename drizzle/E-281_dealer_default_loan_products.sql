------------------------------------------------------------------------------
-- E-281: default loan product per DEALER, and an admin-chosen priority.
--
-- PROBLEM. E-280 pins a default NBFC + loan product to a (state, city), so the
-- choice is driven entirely by where the CUSTOMER lives. There is no way to
-- say "leads from Ayansh Engineering are financed by BatteryPool" — regardless
-- of, or in combination with, the customer's city. The dealer is the party
-- iTarang actually has the commercial arrangement with, so it has to be a
-- dimension of the rule, not something the geography stands in for.
--
-- SHAPE. The E-280 table becomes a general rule table rather than a second one
-- beside it: one resolver, one admin screen, one precedence order. Every
-- scoping column is now NULLABLE and NULL means "any", so a rule matches a lead
-- when every column it actually declares matches:
--
--   dealer_code  state       city     meaning
--   -----------  ----------  -------  -----------------------------------------
--   ACC-…-971    NULL        NULL     that dealer, whoever the customer is
--   ACC-…-971    Delhi       Delhi    that dealer, but only Delhi customers
--   NULL         Delhi       Delhi    any dealer, Delhi customers  (E-280)
--   NULL         Telangana   NULL     state-wide                   (E-280)
--
-- dealer_code is accounts.id / leads.dealer_id — the dealer CODE varchar, NOT
-- dealers.id (the serial int that dealer_nbfc_assignments and the BRE loader
-- use). SectionGLead.dealer_id already carries exactly this value, which is why
-- nothing has to be threaded through section-g.ts to support it.
--
-- PRECEDENCE. `priority` DESC first — the admin decides, rather than a
-- hard-coded rule deciding for them. Specificity only breaks ties: a dealer
-- rule before a location-only one, an exact city before a state, a located rule
-- before an any-location one, then newest id. Every pre-existing E-280 row gets
-- priority 0, so with no dealer rules configured the resolution order is
-- identical to what it is today.
--
-- STILL NEVER WRONG. Unchanged from E-280: the pin is a filter over the BRE's
-- HITS, never a substitute for them. applyPinnedDefault() now walks the matching
-- rules in order and takes the first whose lender AND product independently
-- survived the BRE — so a high-priority rule that is out of amount band, out of
-- battery category, deactivated, blocked for the dealer, or already rejected on
-- this lead falls through to the NEXT rule instead of abandoning the pin, and
-- the full matched list is returned only when none of them fit.
--
-- APPLY WITH E-280. Not independently skippable: the resolver selects
-- dealer_code and priority, so an environment carrying E-280 but not E-281
-- throws on every lookup, is swallowed by the try/catch, and silently offers no
-- defaults at all. Skipping BOTH remains completely safe — that is the
-- pre-E-280 full-matched-list behaviour.
--
-- Strictly additive and idempotent; re-running is a no-op.
------------------------------------------------------------------------------

-- accounts.id / leads.dealer_id. NULL = not dealer-scoped (E-280's behaviour).
-- Loose ref, like nbfc_id and loan_product_id already are on this table;
-- existence is enforced by the POST route against accounts.
ALTER TABLE city_default_loan_products
  ADD COLUMN IF NOT EXISTS dealer_code varchar(255);

-- Admin-chosen tie-break. Defaults to 0 so every existing row keeps its place.
ALTER TABLE city_default_loan_products
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

-- A dealer-only rule declares no location at all. Widening a NOT NULL away is
-- safe and re-runs as a no-op; nothing is narrowed and no row is rewritten.
ALTER TABLE city_default_loan_products
  ALTER COLUMN state DROP NOT NULL;

-- The E-280 key allowed one ACTIVE row per (state, city), which would now
-- collide a dealer rule with a location rule for the same city. Widen the key
-- to include the dealer. It is strictly WIDER than the index it replaces — the
-- existing rows all have dealer_code NULL and were already unique on
-- (state, city) — so the rebuild cannot fail on live data.
DROP INDEX IF EXISTS city_default_loan_products_active_key;
CREATE UNIQUE INDEX IF NOT EXISTS city_default_loan_products_active_key_v2
  ON city_default_loan_products (
    lower(coalesce(dealer_code, '')),
    lower(coalesce(state, '')),
    lower(coalesce(city, ''))
  ) WHERE is_active;

-- resolveDefaultProductRules() filters on is_active and matches dealer_code
-- OR state; the state index from E-280 stays, this covers the dealer leg.
CREATE INDEX IF NOT EXISTS city_default_loan_products_active_dealer_idx
  ON city_default_loan_products (lower(coalesce(dealer_code, ''))) WHERE is_active;

COMMENT ON COLUMN city_default_loan_products.dealer_code IS
  'E-281: accounts.id / leads.dealer_id (the dealer CODE varchar, not dealers.id). NULL = the rule is not dealer-scoped and applies to every dealer.';

COMMENT ON COLUMN city_default_loan_products.priority IS
  'E-281: highest wins. On a tie, specificity decides: dealer rule before location-only, exact city before state, located before any-location, then newest.';

COMMENT ON COLUMN city_default_loan_products.state IS
  'E-281: NULL = the rule declares no location and applies anywhere (only meaningful together with a dealer_code). NOT NULL since E-280 until this migration.';

COMMENT ON TABLE city_default_loan_products IS
  'E-280/E-281: pins one NBFC + loan product as the default offered to a dealer, a location, or both. Every scoping column is nullable and NULL means "any". Ordered by priority DESC then specificity, and applied by applyPinnedDefault() to the BRE hits — a pinned product that does not independently match is skipped and the next rule (or normal matching) is used.';
