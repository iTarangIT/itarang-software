-- E-128_dealer_lead_commercials_product_lines.sql
--
-- The Update Commercials modal gains a structured product picker — pick an
-- asset type + product (from the product_master_batteries / _chargers /
-- _paraphernalia tables), a quantity, and add multiple line items to one
-- quote. Those line items are stored as a JSONB array on the commercials row
-- (mirrors the existing product_selections.paraphernalia_lines pattern — no
-- new table).
--
-- Each element: { asset_type, product_id, product_name, model_id,
--                 unit_price, quantity }
--   asset_type — 'battery' | 'charger' | 'paraphernalia'
--   unit_price — snapshotted at quote time (null for batteries/paraphernalia,
--                which have no catalogue price column) so a later price change
--                never rewrites a recorded quote.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS. Re-running is a no-op.
-- Apply via pgAdmin Query Tool against AWS Postgres.

ALTER TABLE dealer_lead_commercials
    ADD COLUMN IF NOT EXISTS product_lines jsonb DEFAULT '[]'::jsonb;

-- Verification:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'dealer_lead_commercials' AND column_name = 'product_lines';
--   -- expect one row: product_lines / jsonb
