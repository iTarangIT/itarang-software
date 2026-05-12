-- E-050 dependency catch-up.
--
-- The cumulative HEAD (apoorv-claude @ 601bb8c) declares telemetry_events and
-- telemetry_daily_summary in src/lib/db/schema.ts (added by E-047) and the
-- E-047 commit message claims those DDLs were auto-approved into sandbox via
-- `/nbfc loop --auto-approve-schema`. The sandbox database used by E-050 tests
-- (database-1) is missing both tables, so any /api/nbfc/iot/battery/[serial]/*
-- query that touches telemetry_events or telemetry_daily_summary fails with
-- "relation does not exist". This file is a no-op IF the tables already exist
-- and a literal copy of E-047's schema otherwise — guarded by IF NOT EXISTS so
-- it can be re-run safely.
--
-- This SQL is reuse-only of E-047's schema; no new columns or constraints are
-- introduced by E-050.

CREATE TABLE IF NOT EXISTS "telemetry_events" (
  "id"               bigserial PRIMARY KEY,
  "serial_number"    varchar(50) NOT NULL,
  "imei_id"          varchar(20) NOT NULL,
  "device_time"      timestamptz NOT NULL,
  "server_time"      timestamptz NOT NULL DEFAULT now(),
  "soc_percent"      integer,
  "soh_percent"      integer,
  "voltage_v"        numeric(6, 2),
  "current_a"        numeric(7, 2),
  "temperature_c"    numeric(5, 2),
  "charge_cycles"    integer,
  "gps_lat"          numeric(10, 7),
  "gps_lng"          numeric(10, 7),
  "daily_km"         numeric(8, 2),
  "idle_hours"       numeric(6, 2),
  "bms_status"       varchar(50),
  "charger_connected" boolean
);

CREATE INDEX IF NOT EXISTS "telemetry_events_serial_device_time_idx"
  ON "telemetry_events" ("serial_number", "device_time");
CREATE INDEX IF NOT EXISTS "telemetry_events_serial_server_time_idx"
  ON "telemetry_events" ("serial_number", "server_time");

CREATE TABLE IF NOT EXISTS "telemetry_daily_summary" (
  "id"               serial PRIMARY KEY,
  "serial_number"    varchar(50) NOT NULL,
  "summary_date"     date NOT NULL,
  "avg_soc"          numeric(5, 2),
  "min_soc"          numeric(5, 2),
  "max_soh"          numeric(5, 2),
  "total_km"         numeric(8, 2),
  "total_idle_hours" numeric(6, 2),
  "charge_sessions"  integer DEFAULT 0,
  "bms_faults"       integer NOT NULL DEFAULT 0,
  "packets_received" integer NOT NULL DEFAULT 0,
  "gps_home_lat"     numeric(10, 7),
  "gps_home_lng"     numeric(10, 7)
);

CREATE UNIQUE INDEX IF NOT EXISTS "telemetry_daily_summary_serial_date_uniq"
  ON "telemetry_daily_summary" ("serial_number", "summary_date");
CREATE INDEX IF NOT EXISTS "telemetry_daily_summary_date_idx"
  ON "telemetry_daily_summary" ("summary_date");
