------------------------------------------------------------------------------
-- E-191: buyback_lines — dealer-declared battery spec fields.
--
-- The intake form (M02) now asks the dealer for the battery's identity and
-- spec, not just the catalog SKU: brand, chemistry (NMC/LFP), form factor,
-- nominal voltage/ampere, per-unit weight, warranty cycles, the functional /
-- non-functional split of the quantity, and whether it is an IOT-fitted
-- battery (and whose IOT brand if so).
--
-- All columns are NULLABLE on purpose: the intake autosaves a line the moment
-- a SKU is picked, long before the dealer has typed the spec. The REQUIRED
-- fields (brand, chemistry, nominal voltage/ampere, unit weight, IOT yes/no)
-- are enforced by the submit gate (src/lib/buyback/submit-gate.ts), the same
-- place the 5-photo and provenance minimums live — not by NOT NULL, which
-- would break the autosave flow and every pre-existing row.
--
-- Chemistry / form factor are TEXT, validated to NMC|LFP and
-- CELL|PRISMATIC|CYLINDRICAL by zod at the API boundary. No enum type: the
-- allowed set is a product decision that will grow (NCA? sodium-ion?), and an
-- ALTER TYPE on a shared DB is exactly what the migration conventions avoid.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS brand              text;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS chemistry          text;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS form_factor        text;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS nominal_voltage    numeric(8,2);
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS nominal_ampere     numeric(10,2);
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS unit_weight_kg     numeric(10,3);
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS warranty_cycles    integer;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS functional_qty     integer;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS non_functional_qty integer;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS iot_battery        boolean;
  ALTER TABLE buyback_lines ADD COLUMN IF NOT EXISTS iot_brand_name     text;

  COMMENT ON COLUMN buyback_lines.chemistry          IS 'NMC | LFP (zod-validated at the API; TEXT so the set can grow without ALTER TYPE)';
  COMMENT ON COLUMN buyback_lines.form_factor        IS 'CELL | PRISMATIC | CYLINDRICAL (zod-validated at the API)';
  COMMENT ON COLUMN buyback_lines.unit_weight_kg     IS 'Weight per unit in kg, dealer-declared';
  COMMENT ON COLUMN buyback_lines.functional_qty     IS 'Dealer-declared split of `quantity`; submit gate checks functional + non_functional = quantity when both present';
  COMMENT ON COLUMN buyback_lines.iot_brand_name     IS 'Only meaningful when iot_battery is true; submit gate requires it then';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback_lines does not exist here yet (E-185 not applied) — skipping E-191';
END; $do$;
