------------------------------------------------------------------------------
-- E-284: the location on a default loan product rule is the DEALER's, not the
-- customer's.
--
-- NO DDL, NO DML. This file only rewrites the COMMENTs that E-280/E-281 put on
-- `city_default_loan_products`, because the MEANING of two existing columns
-- changed in code and the database would otherwise document the opposite of
-- what the resolver now does. It is safe to skip; nothing reads a comment.
--
-- WHAT CHANGED. `resolveDefaultProductRules()` used to compare `state`/`city`
-- against the CUSTOMER's `leads.state` / `leads.city`. It now joins `accounts`
-- on the lead's dealer code and compares them against `accounts.state` /
-- `accounts.city` — the DEALER's own registered address. The business
-- arrangement is with the dealer, so "dealers in Maharashtra sell iTarang F1"
-- is the rule the business actually writes; where the customer happens to live
-- is already handled by the BRE's own `nbfc_loan_products.active_locations`
-- check, which is unchanged and still runs first.
--
-- EXISTING ROWS ARE REINTERPRETED, NOT MIGRATED. A row saying
-- (Maharashtra, Nashik) used to mean "customers in Nashik" and now means
-- "dealers in Nashik". The strings are still state/city names from the same
-- namespace, so nothing is corrupted, but a rule written under the old meaning
-- may now match a different set of leads (or none). There were 2 such rows when
-- this shipped; review them on the admin screen rather than assuming they
-- carried over. That is also why this is not expressed as a data migration:
-- only a human knows which reading each existing row was meant to have.
--
-- A LEAD WITH NO DEALER NOW MATCHES NOTHING. There is no dealer, so there is no
-- dealer location, so no rule can apply and the customer sees the full matched
-- list. Every lead created on the dealer portal or over WhatsApp carries a
-- dealer, so this is a no-op in practice.
--
-- Idempotent by construction: COMMENT ON overwrites. Re-running is a no-op.
------------------------------------------------------------------------------

COMMENT ON TABLE city_default_loan_products IS
  'E-280/E-281/E-284: pins one NBFC + loan product as the default offered by a dealer, by DEALER LOCATION, or both. Every scoping column is nullable and NULL means "any". state/city are matched against accounts.state / accounts.city (the dealer''s own address) — NOT the customer''s. Ordered by priority DESC then specificity, and applied by applyPinnedDefault() to the BRE hits: a pinned product that does not independently match is skipped and the next rule (or normal matching) is used.';

COMMENT ON COLUMN city_default_loan_products.state IS
  'E-284: the DEALER''s state (accounts.state), not the customer''s. NULL = the rule declares no location and applies to a dealer anywhere (only meaningful together with a dealer_code).';

COMMENT ON COLUMN city_default_loan_products.city IS
  'E-284: the DEALER''s city (accounts.city), not the customer''s. NULL = every dealer city in `state`. An exact (state, city) row takes precedence over a state-wide one at equal priority.';

COMMENT ON COLUMN city_default_loan_products.dealer_code IS
  'E-281: accounts.id / leads.dealer_id (the dealer CODE varchar, not dealers.id). NULL = the rule is not dealer-scoped and applies to every dealer whose LOCATION matches. Since E-284 this column is also what the resolver joins accounts on to read that location.';
