-- E-114 — NBFC loan-product active_locations (state+city pairs)
-- Replaces the iteration-1 `active_cities` (city-only) shape with a structured
-- {state, city} pair list so dealer-side filters can disambiguate same-named
-- cities across states and so we can filter by state. The old `active_cities`
-- column stays in the schema (additive-only migration policy); a future
-- cleanup ticket will drop it. Idempotent + additive — safe to re-run.

ALTER TABLE "nbfc_loan_products"
  ADD COLUMN IF NOT EXISTS "active_locations" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "nbfc_loan_products_active_locations_gin"
  ON "nbfc_loan_products" USING GIN ("active_locations");
