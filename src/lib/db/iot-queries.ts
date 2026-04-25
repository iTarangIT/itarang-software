/**
 * Typed query helpers over the IoT VPS Postgres.
 *
 * All queries take an explicit `vehiclenos: string[]` filter so a tenant only
 * ever sees telemetry for vehicles tied to its loans. The caller is
 * responsible for resolving the tenant → vehicleno set via `nbfc_loans`.
 *
 * Schema reference (lives on the VPS, not mirrored locally):
 *   vehicle_state(vehicleno PK, last_seen, last_gps_at, lat, lon, speed_kph,
 *                 heading, ignition, gps_fix, soc_pct, soh_pct, pack_voltage,
 *                 pack_current, pack_temp_c, charging, online, updated_at)
 *   telemetry_gps(time, vehicleno, lat, lon, speed_kph, heading, ignition, ...)
 *   telemetry_battery(time, vehicleno, soc_pct, soh_pct, pack_voltage, ...)
 *   telemetry_can(time, vehicleno, payload jsonb)
 *   alerts(time, vehicleno, alert_type, severity, message, resolved_at)
 *   daily_distance_per_vehicle(day, vehicleno, km, kwh, trips)
 */
import { iotSql } from "./iot";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FleetSummary {
  total: number;
  online: number;
  fresh_5m: number;
  with_lat: number;
  avg_soc: number | null;
  avg_pack_voltage: number | null;
  open_alerts: number;
}

export interface VehicleStateRow {
  vehicleno: string;
  online: boolean;
  last_gps_at: Date | null;
  sec_since_gps: number | null;
  lat: number | null;
  lon: number | null;
  speed_kph: number | null;
  ignition: boolean | null;
  soc_pct: number | null;
  soh_pct: number | null;
  pack_voltage: number | null;
  pack_temp_c: number | null;
}

export interface DailyKmRow {
  day: Date;
  vehicleno: string;
  km: number;
}

export interface CanSocPoint {
  time: Date;
  soc_pct: number | null;
  pack_voltage: number | null;
  pack_current: number | null;
  pack_temp_c: number | null;
}

export interface OpenAlert {
  time: Date;
  vehicleno: string;
  alert_type: string;
  severity: string;
  message: string;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Aggregated fleet summary scoped to the given vehiclenos. Empty input → zeros.
 * Used by the NBFC overview KPI strip.
 */
export async function getFleetSummary(vehiclenos: string[]): Promise<FleetSummary> {
  if (vehiclenos.length === 0) {
    return {
      total: 0,
      online: 0,
      fresh_5m: 0,
      with_lat: 0,
      avg_soc: null,
      avg_pack_voltage: null,
      open_alerts: 0,
    };
  }

  const stateRows = await iotSql<
    Array<{
      total: string;
      online: string;
      fresh_5m: string;
      with_lat: string;
      avg_soc: string | null;
      avg_pack_voltage: string | null;
    }>
  >`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE online)::int AS online,
      COUNT(*) FILTER (WHERE NOW() - last_gps_at < INTERVAL '5 min')::int AS fresh_5m,
      COUNT(lat)::int AS with_lat,
      AVG(soc_pct)::float AS avg_soc,
      AVG(pack_voltage)::float AS avg_pack_voltage
    FROM vehicle_state
    WHERE vehicleno = ANY(${vehiclenos})
  `;

  const alertsRows = await iotSql<Array<{ count: string }>>`
    SELECT COUNT(*)::int AS count
    FROM alerts
    WHERE vehicleno = ANY(${vehiclenos})
      AND resolved_at IS NULL
  `;

  const s = stateRows[0];
  return {
    total: Number(s?.total ?? 0),
    online: Number(s?.online ?? 0),
    fresh_5m: Number(s?.fresh_5m ?? 0),
    with_lat: Number(s?.with_lat ?? 0),
    avg_soc: s?.avg_soc != null ? Number(s.avg_soc) : null,
    avg_pack_voltage: s?.avg_pack_voltage != null ? Number(s.avg_pack_voltage) : null,
    open_alerts: Number(alertsRows[0]?.count ?? 0),
  };
}

/**
 * Per-vehicle current state, joined with seconds-since-GPS for freshness math.
 * Used both by the overview map and by hand-coded hypothesis cards.
 */
export async function getVehicleStates(vehiclenos: string[]): Promise<VehicleStateRow[]> {
  if (vehiclenos.length === 0) return [];
  const rows = await iotSql<
    Array<{
      vehicleno: string;
      online: boolean;
      last_gps_at: string | null;
      sec_since_gps: number | null;
      lat: string | null;
      lon: string | null;
      speed_kph: string | null;
      ignition: boolean | null;
      soc_pct: string | null;
      soh_pct: string | null;
      pack_voltage: string | null;
      pack_temp_c: string | null;
    }>
  >`
    SELECT
      vehicleno,
      COALESCE(online, false) AS online,
      last_gps_at,
      EXTRACT(EPOCH FROM (NOW() - last_gps_at))::int AS sec_since_gps,
      lat, lon, speed_kph, ignition,
      soc_pct, soh_pct, pack_voltage, pack_temp_c
    FROM vehicle_state
    WHERE vehicleno = ANY(${vehiclenos})
  `;
  return rows.map((r) => ({
    vehicleno: r.vehicleno,
    online: r.online,
    last_gps_at: r.last_gps_at ? new Date(r.last_gps_at) : null,
    sec_since_gps: r.sec_since_gps,
    lat: r.lat != null ? Number(r.lat) : null,
    lon: r.lon != null ? Number(r.lon) : null,
    speed_kph: r.speed_kph != null ? Number(r.speed_kph) : null,
    ignition: r.ignition,
    soc_pct: r.soc_pct != null ? Number(r.soc_pct) : null,
    soh_pct: r.soh_pct != null ? Number(r.soh_pct) : null,
    pack_voltage: r.pack_voltage != null ? Number(r.pack_voltage) : null,
    pack_temp_c: r.pack_temp_c != null ? Number(r.pack_temp_c) : null,
  }));
}

/**
 * Daily km totals per vehicle for the last `days` days.
 * Used for the 7-day usage cliff hypothesis.
 */
export async function getDailyKm(vehiclenos: string[], days: number): Promise<DailyKmRow[]> {
  if (vehiclenos.length === 0) return [];
  const rows = await iotSql<Array<{ day: string; vehicleno: string; km: string }>>`
    SELECT day, vehicleno, km
    FROM daily_distance_per_vehicle
    WHERE vehicleno = ANY(${vehiclenos})
      AND day >= NOW() - (${days}::int || ' days')::interval
    ORDER BY vehicleno, day
  `;
  return rows.map((r) => ({
    day: new Date(r.day),
    vehicleno: r.vehicleno,
    km: Number(r.km ?? 0),
  }));
}

/**
 * 24h CAN time series for a single vehicle (extracts SOC/V/I/temp from JSONB).
 * Used by the per-vehicle drawer and the LangGraph fetch_data tool.
 */
export async function getCanHistory24h(vehicleno: string): Promise<CanSocPoint[]> {
  const rows = await iotSql<
    Array<{
      time: string;
      soc_pct: string | null;
      pack_voltage: string | null;
      pack_current: string | null;
      pack_temp_c: string | null;
    }>
  >`
    SELECT time,
           (payload->'soc'->>'value')::float             AS soc_pct,
           (payload->'battery_voltage'->>'value')::float AS pack_voltage,
           (payload->'current'->>'value')::float         AS pack_current,
           (payload->'battery_temp'->>'value')::float    AS pack_temp_c
    FROM telemetry_can
    WHERE vehicleno = ${vehicleno}
      AND time > NOW() - INTERVAL '24 hours'
    ORDER BY time
  `;
  return rows.map((r) => ({
    time: new Date(r.time),
    soc_pct: r.soc_pct != null ? Number(r.soc_pct) : null,
    pack_voltage: r.pack_voltage != null ? Number(r.pack_voltage) : null,
    pack_current: r.pack_current != null ? Number(r.pack_current) : null,
    pack_temp_c: r.pack_temp_c != null ? Number(r.pack_temp_c) : null,
  }));
}

/**
 * SOH delta over the last 30 days per vehicle. Returns the (current_soh -
 * earliest_soh_30d_ago) for each vno that has data on both ends.
 * Used by the battery-soh-decay hypothesis.
 */
export async function getSohDelta30d(
  vehiclenos: string[],
): Promise<Array<{ vehicleno: string; soh_now: number; soh_30d_ago: number; delta: number }>> {
  if (vehiclenos.length === 0) return [];
  const rows = await iotSql<
    Array<{ vehicleno: string; soh_now: string; soh_30d_ago: string; delta: string }>
  >`
    WITH per_vno AS (
      SELECT vehicleno,
             FIRST_VALUE((payload->'soh'->>'value')::float) OVER (
               PARTITION BY vehicleno ORDER BY time DESC
             ) AS soh_now,
             FIRST_VALUE((payload->'soh'->>'value')::float) OVER (
               PARTITION BY vehicleno ORDER BY time ASC
             ) AS soh_30d_ago
      FROM telemetry_can
      WHERE vehicleno = ANY(${vehiclenos})
        AND time > NOW() - INTERVAL '30 days'
        AND payload ? 'soh'
    )
    SELECT DISTINCT
           vehicleno,
           soh_now::text,
           soh_30d_ago::text,
           (soh_now - soh_30d_ago)::text AS delta
    FROM per_vno
    WHERE soh_now IS NOT NULL AND soh_30d_ago IS NOT NULL
  `;
  return rows.map((r) => ({
    vehicleno: r.vehicleno,
    soh_now: Number(r.soh_now),
    soh_30d_ago: Number(r.soh_30d_ago),
    delta: Number(r.delta),
  }));
}

/**
 * Open alerts for a vehicleno set.
 */
export async function getOpenAlerts(vehiclenos: string[]): Promise<OpenAlert[]> {
  if (vehiclenos.length === 0) return [];
  const rows = await iotSql<
    Array<{ time: string; vehicleno: string; alert_type: string; severity: string; message: string }>
  >`
    SELECT time, vehicleno, alert_type, severity, message
    FROM alerts
    WHERE vehicleno = ANY(${vehiclenos})
      AND resolved_at IS NULL
    ORDER BY time DESC
    LIMIT 500
  `;
  return rows.map((r) => ({ ...r, time: new Date(r.time) }));
}
