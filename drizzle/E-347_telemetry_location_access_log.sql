-- =============================================================================
-- E-347 — LOG OF EVERY OPEN OF ONE VEHICLE'S DATA (tracker ID 181)
-- =============================================================================
-- WHY. Kartik decided on 14 Oct that a dealer sees a vehicle's details (with
-- the owner's name), GPS trail, trips and battery readings only if the vehicle
-- is mapped to that dealer, and that we keep a record of who opened which
-- vehicle's location.
--
-- WHAT. One append-only table on the main CRM database (not the IoT VPS),
-- written by src/lib/telemetry/vehicleAccess.ts logVehicleOpen for every call
-- to /api/telemetry/devices/<vehicle> and its /gps, /trips, /readings feeds,
-- allowed or refused. `hours` is the window served after the 7-day dealer cap
-- (NULL for details and trips).
--
-- The code never requires this table: a failed insert is logged to the server
-- log and the request is answered as decided.
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS telemetry_location_access_log (
    id              bigserial PRIMARY KEY,
    opened_at       timestamptz  NOT NULL DEFAULT now(),
    user_id         uuid,
    role            varchar(64),
    device_id       varchar(100) NOT NULL,
    vehicle_number  varchar(50),
    -- 'details' | 'gps' | 'trips' | 'readings'
    feed            varchar(16)  NOT NULL,
    hours           integer,
    allowed         boolean      NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS telemetry_location_access_log_opened_idx
    ON telemetry_location_access_log (opened_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_location_access_log_user_idx
    ON telemetry_location_access_log (user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_location_access_log_vehicle_idx
    ON telemetry_location_access_log (vehicle_number, opened_at DESC);
