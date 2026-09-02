-- E-272: inventory.price_inclusive_gst
--
-- Dedicated "Price Inclusive GST" column on inventory:
--   price_inclusive_gst = inventory_amount (Base Value) × (1 + gst_percent / 100)
-- final_amount already carries this figure and is kept (nothing reads it
-- differently); the new column is the explicit, named home for the value and
-- is written by every inventory write path from this migration on.
--
-- Idempotent and additive. Re-running is a no-op.

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS price_inclusive_gst numeric(12,2);

COMMENT ON COLUMN inventory.price_inclusive_gst IS
  'E-272: Base Value (inventory_amount) + GST on it = inventory_amount * (1 + gst_percent/100). Mirrors final_amount.';

-- Backfill: prefer the already-stored final_amount; derive when it is missing.
UPDATE inventory
   SET price_inclusive_gst = COALESCE(
         final_amount,
         ROUND(inventory_amount * (1 + COALESCE(gst_percent, 0) / 100), 2)
       )
 WHERE price_inclusive_gst IS NULL
   AND inventory_amount IS NOT NULL;
