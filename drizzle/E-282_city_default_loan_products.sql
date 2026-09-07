------------------------------------------------------------------------------
-- E-282: default loan product + NBFC per city / state.
--
-- PROBLEM. When a finance customer reaches Step 4 — on the web
-- (/dealer-portal/leads/[id]/product-selection) or over WhatsApp — the lender
-- list is a pure BRE match on state / city / amount / battery-category. Every
-- loan product that happens to declare the customer's city in
-- nbfc_loan_products.active_locations shows up as "iTarang Scheme 1..N".
-- There is no way for the business to steer a city to one chosen lender.
-- (nbfc.active_geographies is stored but read by no matcher;
-- calc_nbfc_coverage.PAN_INDIA only affects the standalone Loan Calculator.)
--
-- SHAPE. One ACTIVE row pins (state, city) -> (nbfc, loan product). A row with
-- city IS NULL is a STATE-WIDE default; an exact (state, city) row wins over
-- it. resolveCityDefault() in src/lib/leads/city-default-product.ts does that
-- lookup, and loadSectionGOptions() (src/lib/leads/section-g.ts) — the single
-- entry point shared by the web route and the WhatsApp step-4 flow — narrows
-- its matched list to that one NBFC + product.
--
-- EXCLUSIVE, BUT NEVER WRONG. The narrowing is applied to the BRE's HITS, not
-- in place of them: the pinned product is only shown if it independently
-- matched. So a default whose loan_amount_max sits below the customer's
-- requested amount, whose battery category does not apply, that has been
-- deactivated, or whose NBFC is blocked for this dealer, is simply absent from
-- the hits and the full matched list is shown instead. A customer is never
-- offered a product that would reject them.
--
-- SAFE TO SKIP at deploy. resolveCityDefault() swallows its errors and returns
-- null, so an environment without this table behaves exactly as it does today.
-- Only the admin screen (Settings -> Loan Product) needs the table.
--
-- Strictly additive and idempotent; re-running is a no-op.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS city_default_loan_products (
  id              serial PRIMARY KEY,
  -- State and city names as the `country-state-city` package spells them —
  -- the same source leads.state / leads.city are captured from, which is what
  -- lets the BRE's exact string comparison line up. Matched case-insensitively
  -- on read regardless.
  state           varchar(100) NOT NULL,
  -- NULL = state-wide default, used when no exact city row exists.
  city            varchar(100),
  nbfc_id         integer      NOT NULL,  -- nbfc.id
  loan_product_id integer      NOT NULL,  -- nbfc_loan_products.id
  is_active       boolean      NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- One live default per city, and one per state-wide row. coalesce(city,'')
-- folds the NULL city into the key so the state-wide row participates.
-- Deactivation (is_active=false) frees the slot and keeps the old row as
-- history, mirroring dealer_salespersons / whatsapp_operators.
-- SUPERSEDED BY E-283, which widens this key to include dealer_code and drops
-- this one. Guarded so that re-running E-282 on a database that already has
-- E-283 does NOT resurrect the narrow key — it would then forbid a dealer rule
-- and a location rule coexisting for the same city. Re-running either file in
-- either order stays a no-op.
-- Guarded against EVERY successor key, not just the next one: E-283 replaces
-- this with _active_key_v2 and E-289 replaces that with _active_key_v3, so
-- re-running this file on an up-to-date database must not resurrect the narrow
-- key. It would forbid a dealer rule and a location rule coexisting for one
-- city, and forbid two rules differing only in the customer they target.
DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'city_default_loan_products'
       AND indexname IN (
         'city_default_loan_products_active_key_v2',
         'city_default_loan_products_active_key_v3'
       )
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS city_default_loan_products_active_key
      ON city_default_loan_products (lower(state), lower(coalesce(city, '')))
      WHERE is_active;
  END IF;
END; $do$;

-- resolveCityDefault() filters on is_active + lower(state); the table is small
-- (one row per served city) so this is all the support it needs.
CREATE INDEX IF NOT EXISTS city_default_loan_products_active_state_idx
  ON city_default_loan_products (lower(state)) WHERE is_active;

COMMENT ON TABLE city_default_loan_products IS
  'E-282: pins one NBFC + loan product as the default offered in a city (or state-wide when city IS NULL). Applied by loadSectionGOptions() to the BRE hits, so a pinned product that does not independently match is skipped and normal matching resumes.';

COMMENT ON COLUMN city_default_loan_products.city IS
  'E-282: NULL = state-wide default. An exact (state, city) row takes precedence over it.';
