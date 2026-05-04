-- ============================================================================
-- VPS Postgres tables for the iTarang NBFC portal (run on iot_stack DB).
--
-- Connection (user runs as superuser / owner):
--   psql "postgres://<owner>@<vps-ip>:5433/intellicar"
--
-- These four tables extend the existing iot_stack schema (vehicle_state,
-- telemetry_battery, telemetry_gps, telemetry_can, alerts,
-- dashboard_nbfc_loans_with_iot, etc.) with aggregates the NBFC dashboard
-- needs but cannot derive cheaply on each request.
--
-- Population is done by the iot_stack aggregator jobs (Python). The CRM only
-- READS these tables via the existing dashboard_ro role; final GRANT block
-- below makes that explicit.
-- ============================================================================

-- 1) Battery health metrics — daily SOH degradation rate + EOL prediction.
--    Aggregator job (e.g. once a day at 02:00 UTC) computes from
--    telemetry_battery for each vehicleno that reported in the last 24h.
CREATE TABLE IF NOT EXISTS battery_health_metrics (
  vehicleno              text         NOT NULL,
  sample_date            date         NOT NULL,
  soh_pct                numeric(5,2) NOT NULL,
  degradation_rate_30d   numeric(6,3),                       -- pp per day, signed
  predicted_eol_date     date,                               -- date when projected SOH crosses 60%
  cycles_since_install   integer,
  PRIMARY KEY (vehicleno, sample_date)
);
CREATE INDEX IF NOT EXISTS battery_health_metrics_eol_idx
  ON battery_health_metrics (predicted_eol_date);


-- 2a) Geofence events — entry / exit / violation log.
--     Drives the §6.1.5 "Geo-Shift >100km" alert and the per-battery drawer
--     timeline in the NBFC portal.
CREATE TABLE IF NOT EXISTS geofence_events (
  id           bigserial    PRIMARY KEY,
  vehicleno    text         NOT NULL,
  geofence_id  text         NOT NULL,
  event_type   text         NOT NULL CHECK (event_type IN ('enter','exit','violation')),
  event_time   timestamptz  NOT NULL,
  lat          numeric(9,6),
  lon          numeric(9,6),
  distance_km  numeric(8,2)                                  -- distance from home cluster centroid
);
CREATE INDEX IF NOT EXISTS geofence_events_vehicle_time_idx
  ON geofence_events (vehicleno, event_time DESC);


-- 2b) Immobilizer state — current state + last toggle audit.
--     Updated by the iot_stack worker AFTER it confirms the device executed
--     the command. CRM never writes here.
--     last_request_id correlates back to nbfc_immobilisation_actions.id in
--     the iTarang CRM Postgres (NOT a foreign key — different DBs).
CREATE TABLE IF NOT EXISTS immobilizer_state (
  vehicleno         text        PRIMARY KEY,
  enabled           boolean     NOT NULL,
  last_toggled_at   timestamptz,
  last_reason       text,
  last_request_id   text                                     -- correlates to CRM nbfc_immobilisation_actions.id
);


-- 3) Charge events — discrete charge sessions.
--    Aggregator derives these from telemetry_battery (charging=true window).
CREATE TABLE IF NOT EXISTS charge_events (
  id              bigserial    PRIMARY KEY,
  vehicleno       text         NOT NULL,
  start_time      timestamptz  NOT NULL,
  end_time        timestamptz,
  start_soc_pct   numeric(5,2),
  end_soc_pct     numeric(5,2),
  energy_kwh      numeric(8,3),
  duration_s      integer,
  charger_kind    text                                       -- 'ac_slow' | 'dc_fast' | 'unknown'
);
CREATE INDEX IF NOT EXISTS charge_events_vehicle_start_idx
  ON charge_events (vehicleno, start_time DESC);


-- 4) Fault codes — BMS / CAN DTCs. Severity drives the "BMS fault" risk rule.
CREATE TABLE IF NOT EXISTS fault_codes (
  id           bigserial    PRIMARY KEY,
  vehicleno    text         NOT NULL,
  dtc_code     text         NOT NULL,
  description  text,
  severity     text         NOT NULL CHECK (severity IN ('info','warning','critical')),
  raised_at    timestamptz  NOT NULL,
  resolved_at  timestamptz
);
-- Partial index so "open faults per vehicle" (the most common query from the
-- NBFC battery drawer) hits a tiny index instead of scanning the full table.
CREATE INDEX IF NOT EXISTS fault_codes_vehicle_open_idx
  ON fault_codes (vehicleno) WHERE resolved_at IS NULL;


-- ============================================================================
-- Read grants for the CRM's IOT_DATABASE_URL role.
-- ============================================================================
GRANT SELECT ON
    battery_health_metrics,
    geofence_events,
    immobilizer_state,
    charge_events,
    fault_codes
  TO dashboard_ro;
