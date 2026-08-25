-- E-268: deployed_assets.warranty_months — the duration applied at dispatch.
--
-- WHY. `finalizeSale` computed the warranty end date from
-- `products.warranty_months ?? 24`. That column is `integer NOT NULL DEFAULT 0`
-- and the Step-4 product route stubs a `products` row with `warranty_months: 0`
-- for any inventory model it cannot match — so the `?? 24` never fired and
-- dispatched batteries were written with a warranty that ended on the day of
-- dispatch. The resolution is now positive-first across
-- inventory.warranty_months → products.warranty_months → inventory.oem_warranty_months → 24.
--
-- This column records WHICH duration was applied, so the WhatsApp "Active
-- batteries" card and the dealer portal never have to reverse month arithmetic
-- from two timestamps. Nullable: rows written before this migration carry only
-- the dates. A reader must fall back to the dates when it is NULL.
--
-- Strictly additive. Re-running is a no-op. No backfill: the historical rows'
-- dates are what the customer was told, and scripts/repair-dispatched-warranty-emi.ts
-- exists for the case-by-case correction of the ones written with 0 months.

ALTER TABLE deployed_assets
  ADD COLUMN IF NOT EXISTS warranty_months integer;

COMMENT ON COLUMN deployed_assets.warranty_months IS
  'E-268: warranty duration applied at dispatch (inventory → product → OEM → 24). NULL on rows written before E-268.';
