-- BRD V2 §2.5 — Step 4 Confirm Sale (cash) and Submit (finance) both write a
-- per-line GST snapshot to product_selections so the admin/dealer reads
-- exactly what the dealer saw at submission time. Drizzle schema declared
-- these columns but they were never pushed to the live DB, which is why
-- POST /api/lead/:id/confirm-cash-sale and submit-product-selection were
-- silently failing with "column does not exist".
--
-- Idempotent — safe to re-run.

ALTER TABLE "product_selections"
  ADD COLUMN IF NOT EXISTS "battery_gross"        numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "battery_gst_percent"  numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "battery_gst_amount"   numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "battery_net"          numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "charger_gross"        numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "charger_gst_percent"  numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "charger_gst_amount"   numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "charger_net"          numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "paraphernalia_lines"  jsonb,
  ADD COLUMN IF NOT EXISTS "gross_subtotal"       numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "gst_subtotal"         numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "net_subtotal"         numeric(12, 2);
