-- E-189 — Battery spec models for Intellicar electrical analytics.
--
-- The Battery Analytics tab's electrical thresholds (under/over-voltage, over-current,
-- over-temperature) were fleet-wide placeholders (app_settings row > env > defaults).
-- This adds a per-MODEL spec catalog so packs are judged against their manufacturer's
-- limits: battery_spec_models holds one row per pack model, and device_battery_map
-- gains a battery_model column mapping each deployment to a model (CRM-side, because
-- the IoT telemetry DB is read-only and its vehicles.makemodel is vendor free text —
-- same pattern as E-184's state/city).
--
-- Resolution order in src/lib/telemetry/thresholds.ts: model spec > app_settings >
-- env > defaults, per field. A NULL spec column means "no manufacturer limit
-- recorded" and falls through. These remain DISPLAY thresholds — the alerting
-- pipeline's thresholds live in the AWS iot_stack poller, outside this repo.
--
-- Specs are maintained by SQL only (no admin UI, by design). To map deployments:
--   UPDATE device_battery_map SET battery_model = '<model_name>' WHERE <criteria>;
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS battery_spec_models (
  model_name         varchar(100) PRIMARY KEY,
  rated_voltage_v    numeric(6,2),
  rated_capacity_ah  numeric(7,2),
  under_voltage_v    numeric(6,2),
  over_voltage_v     numeric(6,2),
  over_current_a     numeric(6,2),
  over_temperature_c numeric(5,2),
  notes              text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

COMMENT ON TABLE battery_spec_models IS
  'E-189 — per-model battery specs (rated voltage/capacity + display thresholds) for Intellicar electrical analytics. NULL threshold = fall through to fleet settings.';

ALTER TABLE device_battery_map
  ADD COLUMN IF NOT EXISTS battery_model varchar(100);

COMMENT ON COLUMN device_battery_map.battery_model IS
  'E-189 — logical FK to battery_spec_models.model_name; the pack model deployed on this vehicle.';

-- Seed: the fleet''s dominant pack as telemetry reports it (rated_capacity 105 Ah,
-- ~51.2 V LFP nominal). Voltage/current limits mirror today''s fleet-wide defaults so
-- mapping a vehicle to this model changes nothing until real manufacturer limits are
-- filled in — replace with the spec sheet''s numbers when known.
INSERT INTO battery_spec_models
  (model_name, rated_voltage_v, rated_capacity_ah, under_voltage_v, over_voltage_v,
   over_current_a, over_temperature_c, notes)
VALUES
  ('LFP-51V-105AH', 51.20, 105.00, 44.00, 60.00, 70.00, 55.00,
   'E-189 seed — placeholder limits equal to fleet defaults; update from manufacturer spec sheet.')
ON CONFLICT (model_name) DO NOTHING;
