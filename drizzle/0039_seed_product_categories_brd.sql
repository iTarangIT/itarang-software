-- BRD V2 §5.0 / §5.1 — seed product_categories with the canonical six
-- inventory categories. Bulk-upload validation (admin/inventory/bulk-upload)
-- looks up CSV `category` and `compatible_category` values against this table;
-- without these rows, paraphernalia uploads with `compatible_category = "3W|2W"`
-- and battery/charger uploads with `category = "3W"` get rejected as
-- "has no values matching the product master".
--
-- Idempotent — INSERT … ON CONFLICT DO NOTHING on (slug). Existing rows like
-- "3W Batteries" are preserved.

INSERT INTO product_categories (name, slug, is_active)
VALUES
  ('3W',       '3w',       true),
  ('2W',       '2w',       true),
  ('4W',       '4w',       true),
  ('Inverter', 'inverter', true),
  ('Solar',    'solar',    true),
  ('Other',    'other',    true)
ON CONFLICT (slug) DO NOTHING;
