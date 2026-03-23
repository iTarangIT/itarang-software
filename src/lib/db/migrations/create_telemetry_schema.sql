-- Create telemetry schema and tables for Intellicar Dashboard
-- Run this in Supabase SQL Editor

CREATE SCHEMA IF NOT EXISTS telemetry;

-- Battery readings from IntelliCar devices
CREATE TABLE IF NOT EXISTS telemetry.battery_readings (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(100) NOT NULL,
    soc NUMERIC(5, 2),          -- State of Charge (%)
    soh NUMERIC(5, 2),          -- State of Health (%)
    voltage NUMERIC(8, 3),
    current_val NUMERIC(8, 3),
    temperature NUMERIC(6, 2),
    bms_alarm_status INTEGER DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battery_readings_device_id ON telemetry.battery_readings(device_id);
CREATE INDEX IF NOT EXISTS idx_battery_readings_recorded_at ON telemetry.battery_readings(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_battery_readings_device_recorded ON telemetry.battery_readings(device_id, recorded_at DESC);

-- GPS readings from IntelliCar devices
CREATE TABLE IF NOT EXISTS telemetry.gps_readings (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(100) NOT NULL,
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    speed NUMERIC(6, 2),
    heading NUMERIC(5, 2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gps_readings_device_id ON telemetry.gps_readings(device_id);
CREATE INDEX IF NOT EXISTS idx_gps_readings_recorded_at ON telemetry.gps_readings(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_gps_readings_device_recorded ON telemetry.gps_readings(device_id, recorded_at DESC);

-- Trip records derived from GPS/battery data
CREATE TABLE IF NOT EXISTS telemetry.trips (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(100) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    distance_km NUMERIC(8, 2),
    start_soc NUMERIC(5, 2),
    end_soc NUMERIC(5, 2),
    energy_consumed_kwh NUMERIC(8, 3),
    avg_speed NUMERIC(6, 2),
    max_speed NUMERIC(6, 2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trips_device_id ON telemetry.trips(device_id);
CREATE INDEX IF NOT EXISTS idx_trips_start_time ON telemetry.trips(start_time DESC);

-- Alert configuration thresholds
CREATE TABLE IF NOT EXISTS public.alert_config (
    id SERIAL PRIMARY KEY,
    alert_type VARCHAR(50) NOT NULL UNIQUE,
    threshold_value NUMERIC(10, 2) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    description TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default alert config
INSERT INTO public.alert_config (alert_type, threshold_value, severity, description)
VALUES
    ('low_soc', 20, 'warning', 'Battery SOC below threshold'),
    ('critical_soc', 10, 'critical', 'Battery SOC critically low'),
    ('low_soh', 80, 'warning', 'Battery health degraded'),
    ('critical_soh', 60, 'critical', 'Battery health critical'),
    ('high_temperature', 45, 'warning', 'Battery temperature high'),
    ('critical_temperature', 55, 'critical', 'Battery temperature critical'),
    ('offline_device', 24, 'warning', 'Device offline for hours')
ON CONFLICT (alert_type) DO NOTHING;
