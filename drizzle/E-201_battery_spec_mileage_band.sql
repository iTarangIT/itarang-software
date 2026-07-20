-- E-201 — Mileage (km per Ah) normal-range band for battery spec models.
--
-- E-190 gave battery_spec_models per-model electrical thresholds (under/over-voltage,
-- over-current, over-temperature). It has NO mileage spec, so the mileage charts on the
-- Battery Analytics tab (Mileage Trend / Per-Cycle Mileage / Ah vs Mileage) draw only a
-- COMPUTED "pack's own best" baseline — there is no configured normal range to compare
-- against. This adds one.
--
-- Efficiency is expressed as kilometres per amp-hour (km/Ah), the same unit those charts
-- already plot. A pack's expected efficiency band is a property of the MODEL, so — exactly
-- like rated_capacity_ah — it is spec-only: it lives here on battery_spec_models and is
-- resolved per-vehicle via device_battery_map.battery_model, with NO app_settings/env/default
-- rung. A NULL column means "no band recorded" and the chart simply draws no line (same
-- philosophy as capacityBands() returning null rather than inventing a number).
--
-- Specs are maintained by SQL only (no admin UI, by design). These remain DISPLAY values —
-- the alerting pipeline lives in the AWS iot_stack poller, outside this repo.
--
-- Additive + idempotent.

ALTER TABLE battery_spec_models
  ADD COLUMN IF NOT EXISTS min_mileage_km_per_ah numeric(6,3),
  ADD COLUMN IF NOT EXISTS max_mileage_km_per_ah numeric(6,3);

COMMENT ON COLUMN battery_spec_models.min_mileage_km_per_ah IS
  'E-201 — lower bound of the normal km-per-Ah efficiency band; below it is poor mileage (overload/degradation). NULL = no lower line drawn.';
COMMENT ON COLUMN battery_spec_models.max_mileage_km_per_ah IS
  'E-201 — upper bound of the normal km-per-Ah efficiency band; above it is implausibly efficient (worth a data check). NULL = no upper line drawn.';

-- Seed the dominant pack (105 Ah, ~51.2 V LFP) with an EXAMPLE band. These are PLACEHOLDER
-- numbers sized to what this fleet's telemetry shows (~0.48 km/Ah typical) — replace with
-- real per-model figures once agreed (review with Apoorv). Idempotent: only fills the row
-- while both columns are still unset, so a re-run — or a later hand-edit — is never clobbered.
UPDATE battery_spec_models
   SET min_mileage_km_per_ah = 0.350,
       max_mileage_km_per_ah = 0.650
 WHERE model_name = 'LFP-51V-105AH'
   AND min_mileage_km_per_ah IS NULL
   AND max_mileage_km_per_ah IS NULL;
