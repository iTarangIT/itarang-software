-- E-184 — State/City on device_battery_map (Intellicar Fleet Overview filters).
--
-- The CEO Intellicar dashboard (/ceo/intellicar → Fleet Overview) needs to
-- filter the fleet KPIs and battery list by State and City. device_battery_map
-- (the dealer↔vehicle deployment bridge) previously stored no location, and the
-- VPS telemetry only has raw GPS lat/lon. We add explicit state/city here so the
-- deployment location can be captured at onboarding and used to resolve the
-- vehicle-number set the dashboard queries filter on.
--
-- Additive + idempotent.

ALTER TABLE device_battery_map
  ADD COLUMN IF NOT EXISTS state text;

ALTER TABLE device_battery_map
  ADD COLUMN IF NOT EXISTS city text;

-- Filter dropdowns list DISTINCT state/city and the fleet queries resolve
-- vehicle numbers by (state, city); this index backs both.
CREATE INDEX IF NOT EXISTS device_battery_map_state_city_idx
  ON device_battery_map (state, city);

COMMENT ON COLUMN device_battery_map.state IS
  'E-184 — deployment state for the Intellicar Fleet Overview State filter.';
COMMENT ON COLUMN device_battery_map.city IS
  'E-184 — deployment city for the Intellicar Fleet Overview City filter.';
