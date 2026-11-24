-- E-395 — Type of business vs Segment (24 Nov tree). DATA ONLY, no DDL.
--
--   LEAD
--   ├── Type of business  ONE   battery_sale | buyback | scrap | other
--   └── Segment           MANY  "3W batteries" | "2W batteries" | "Solar" |
--                               "Inverter" | "BESS" | "ESS"
--
-- 23–24 Nov the products were briefly TYPES (two_wheeler, three_wheeler,
-- lithium_battery, solar). Those rows become Battery Sale + their segment:
--   three_wheeler   → battery_sale, segments + "3W batteries"
--   two_wheeler     → battery_sale, segments + "2W batteries"
--   solar           → battery_sale, segments + "Solar"
--   lithium_battery → battery_sale (no segment: the rep picks it at the next visit)
-- and the bulk upload's old segment spellings are renamed:
--   "3W" → "3W batteries", "2W" → "2W batteries"
-- ("Auto-Parts" / "Battery" are left as they are; the app shows them.)
--
-- Idempotent: a second run finds nothing to change. Business type is
-- varchar(30) with no CHECK (E-296), segments is jsonb (E-112).
--
-- Check before / after:
--   SELECT business_type, count(*) FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC;
--   SELECT s, count(*) FROM dealer_leads, jsonb_array_elements_text(COALESCE(segments,'[]'::jsonb)) s GROUP BY 1;

DO $do$
BEGIN
    -- 1. Product types → Battery Sale + segment (dedupe, keep order).
    UPDATE dealer_leads dl
       SET segments = (
               SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                 FROM jsonb_array_elements_text(
                          COALESCE(CASE WHEN jsonb_typeof(dl.segments) = 'array' THEN dl.segments END, '[]'::jsonb)
                          || CASE dl.business_type
                                 WHEN 'three_wheeler' THEN '["3W batteries"]'::jsonb
                                 WHEN 'two_wheeler'   THEN '["2W batteries"]'::jsonb
                                 WHEN 'solar'         THEN '["Solar"]'::jsonb
                                 ELSE '[]'::jsonb
                             END) AS v),
           business_type = 'battery_sale',
           updated_at = NOW()
     WHERE dl.business_type IN ('three_wheeler', 'two_wheeler', 'solar', 'lithium_battery');

    -- 2. Old segment spellings → the new labels.
    UPDATE dealer_leads dl
       SET segments = (
               SELECT COALESCE(jsonb_agg(DISTINCT CASE v WHEN '3W' THEN '3W batteries' WHEN '2W' THEN '2W batteries' ELSE v END), '[]'::jsonb)
                 FROM jsonb_array_elements_text(dl.segments) AS v),
           updated_at = NOW()
     WHERE jsonb_typeof(dl.segments) = 'array'
       AND (dl.segments ? '3W' OR dl.segments ? '2W');

    COMMENT ON COLUMN dealer_leads.business_type IS
        'Type of business (24 Nov tree): battery_sale | buyback | scrap | other. Products are in segments. Enforced in src/lib/leads/businessType.ts (no CHECK).';
EXCEPTION
    WHEN undefined_column OR undefined_table THEN
        RAISE NOTICE 'E-395 skip: dealer_leads.business_type / segments missing (E-296 / E-112 not applied)';
END;
$do$;
