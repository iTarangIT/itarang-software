/**
 * Typed query helpers over the IoT VPS Postgres.
 *
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
import { getIotSql } from "./iot";
import { db } from "./index";
import { nbfcImmobilisationActions, nbfcRiskRules } from "./schema";
import { desc, eq } from "drizzle-orm";

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

  const iotSql = getIotSql();
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
  const iotSql = getIotSql();
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
  const iotSql = getIotSql();
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
  const iotSql = getIotSql();
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
  const iotSql = getIotSql();
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

// ─── New tables shipped via docs/nbfc/vps_tables.sql ────────────────────────
// All five helpers below degrade gracefully (return null / []) when the
// table does not yet exist on the VPS — that lets the NBFC portal render
// before the user runs the DDL on their iot_stack DB.

export interface BatteryHealthRow {
  vehicleno: string;
  sample_date: Date;
  soh_pct: number;
  degradation_rate_30d: number | null;
  predicted_eol_date: Date | null;
  cycles_since_install: number | null;
}

export interface GeofenceEventRow {
  id: number;
  vehicleno: string;
  geofence_id: string;
  event_type: "enter" | "exit" | "violation";
  event_time: Date;
  lat: number | null;
  lon: number | null;
  distance_km: number | null;
}

export interface ImmobilizerStateRow {
  vehicleno: string;
  enabled: boolean;
  last_toggled_at: Date | null;
  last_reason: string | null;
  last_request_id: string | null;
}

export interface ChargeEventRow {
  id: number;
  vehicleno: string;
  start_time: Date;
  end_time: Date | null;
  start_soc_pct: number | null;
  end_soc_pct: number | null;
  energy_kwh: number | null;
  duration_s: number | null;
  charger_kind: string | null;
}

export interface FaultCodeRow {
  id: number;
  vehicleno: string;
  dtc_code: string;
  description: string | null;
  severity: "info" | "warning" | "critical";
  raised_at: Date;
  resolved_at: Date | null;
}

function isMissingTable(err: unknown): boolean {
  // postgres.js sets `code` on driver errors; 42P01 = undefined_table.
  const e = err as { code?: string } | null | undefined;
  return e?.code === "42P01";
}

export async function getBatteryHealth(
  vehicleno: string,
): Promise<BatteryHealthRow | null> {
  // Primary source — the precomputed battery_health_metrics row, filled by the
  // iot_stack aggregator job. This is the production path.
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        vehicleno: string;
        sample_date: string;
        soh_pct: string;
        degradation_rate_30d: string | null;
        predicted_eol_date: string | null;
        cycles_since_install: number | null;
      }>
    >`
      SELECT vehicleno, sample_date, soh_pct, degradation_rate_30d,
             predicted_eol_date, cycles_since_install
      FROM battery_health_metrics
      WHERE vehicleno = ${vehicleno}
      ORDER BY sample_date DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      const r = rows[0];
      return {
        vehicleno: r.vehicleno,
        sample_date: new Date(r.sample_date),
        soh_pct: Number(r.soh_pct),
        degradation_rate_30d:
          r.degradation_rate_30d != null
            ? Number(r.degradation_rate_30d)
            : null,
        predicted_eol_date: r.predicted_eol_date
          ? new Date(r.predicted_eol_date)
          : null,
        cycles_since_install: r.cycles_since_install,
      };
    }
    // Table exists but has no aggregator row for this vehicle — fall through.
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    // battery_health_metrics absent entirely — fall through to derive.
  }
  // Fallback — derive SOH health live from telemetry_battery so the Battery
  // Health card still populates before the aggregator table exists/fills.
  return deriveBatteryHealthFromTelemetry(vehicleno);
}

/**
 * Derives a BatteryHealthRow from raw telemetry_battery.soh_pct over the last
 * 30 days. degradation_rate_30d is the signed pp/day slope between the oldest
 * and newest SOH reading in the window (positive = SOH falling). The EOL date
 * linearly projects that slope to the 60% SOH threshold, but only when the
 * battery is actually declining and the crossing lands within a 20-year
 * horizon — a near-flat SOH yields no prediction. cycles_since_install is left
 * null (charge-cycle counting needs the aggregator's full install history).
 */
async function deriveBatteryHealthFromTelemetry(
  vehicleno: string,
): Promise<BatteryHealthRow | null> {
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        soh_now: number | null;
        sample_time: string | null;
        soh_first: number | null;
        first_time: string | null;
      }>
    >`
      WITH win AS (
        SELECT time, soh_pct
        FROM telemetry_battery
        WHERE vehicleno = ${vehicleno}
          AND soh_pct IS NOT NULL
          AND time > NOW() - INTERVAL '30 days'
      )
      SELECT
        (SELECT soh_pct FROM win ORDER BY time DESC LIMIT 1) AS soh_now,
        (SELECT time    FROM win ORDER BY time DESC LIMIT 1) AS sample_time,
        (SELECT soh_pct FROM win ORDER BY time ASC  LIMIT 1) AS soh_first,
        (SELECT time    FROM win ORDER BY time ASC  LIMIT 1) AS first_time
    `;
    const r = rows[0];
    if (!r || r.soh_now == null || r.sample_time == null) return null;

    const sohNow = Number(r.soh_now);
    const sampleDate = new Date(r.sample_time);
    const DAY_MS = 86_400_000;

    let degradationRate: number | null = null;
    let predictedEol: Date | null = null;
    if (r.soh_first != null && r.first_time != null) {
      const sohFirst = Number(r.soh_first);
      const spanDays =
        (sampleDate.getTime() - new Date(r.first_time).getTime()) / DAY_MS;
      if (spanDays >= 1) {
        degradationRate = (sohFirst - sohNow) / spanDays;
        if (degradationRate > 0 && sohNow > 60) {
          const daysToEol = (sohNow - 60) / degradationRate;
          if (daysToEol > 0 && daysToEol <= 365 * 20) {
            predictedEol = new Date(sampleDate.getTime() + daysToEol * DAY_MS);
          }
        }
      }
    }

    return {
      vehicleno,
      sample_date: sampleDate,
      soh_pct: sohNow,
      degradation_rate_30d: degradationRate,
      predicted_eol_date: predictedEol,
      cycles_since_install: null,
    };
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** Haversine great-circle distance in km (mirrors evaluatePacketAlerts.ts). */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Reads the configurable geo-shift threshold (km) from nbfc_risk_rules. */
async function loadGeoShiftKm(): Promise<number> {
  try {
    const rows = await db
      .select({ current_value: nbfcRiskRules.current_value })
      .from(nbfcRiskRules)
      .where(eq(nbfcRiskRules.rule_key, "geo_shift_km"))
      .limit(1);
    const v =
      rows[0]?.current_value != null ? Number(rows[0].current_value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 100; // BRD §6.1.5 default.
  } catch {
    return 100;
  }
}

// Home-geofence radius for routine enter/exit events. The BRD only specs the
// 100km geo-shift "violation"; this smaller radius surfaces day-to-day moves.
const GEOFENCE_HOME_RADIUS_KM = 5;

export async function getGeofenceEvents(
  vehicleno: string,
  days: number,
): Promise<GeofenceEventRow[]> {
  // Primary — VPS geofence_events (production aggregator path).
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        id: string;
        vehicleno: string;
        geofence_id: string;
        event_type: "enter" | "exit" | "violation";
        event_time: string;
        lat: string | null;
        lon: string | null;
        distance_km: string | null;
      }>
    >`
      SELECT id, vehicleno, geofence_id, event_type, event_time, lat, lon, distance_km
      FROM geofence_events
      WHERE vehicleno = ${vehicleno}
        AND event_time > NOW() - (${days}::int || ' days')::interval
      ORDER BY event_time DESC
      LIMIT 200
    `;
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: Number(r.id),
        vehicleno: r.vehicleno,
        geofence_id: r.geofence_id,
        event_type: r.event_type,
        event_time: new Date(r.event_time),
        lat: r.lat != null ? Number(r.lat) : null,
        lon: r.lon != null ? Number(r.lon) : null,
        distance_km: r.distance_km != null ? Number(r.distance_km) : null,
      }));
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  // Fallback — derive enter/exit/violation events from telemetry_gps.
  return deriveGeofenceEventsFromGps(vehicleno, days);
}

/**
 * Derives geofence events from telemetry_gps over the window.
 *
 * Home centroid = the modal GPS cluster — points binned to ~0.1deg cells, the
 * most-visited cell's mean — mirroring the home-cluster heuristic in
 * evaluatePacketAlerts.ts. The time-ordered track is then walked:
 *   - crossing OUT of GEOFENCE_HOME_RADIUS_KM   -> "exit"
 *   - crossing back IN                          -> "enter"
 *   - first point beyond the geo_shift_km rule  -> "violation" (once per trip)
 */
async function deriveGeofenceEventsFromGps(
  vehicleno: string,
  days: number,
): Promise<GeofenceEventRow[]> {
  try {
    const iotSql = getIotSql();
    const raw = await iotSql<
      Array<{ time: string; lat: number | null; lon: number | null }>
    >`
      SELECT time, lat, lon
      FROM telemetry_gps
      WHERE vehicleno = ${vehicleno}
        AND time > NOW() - (${days}::int || ' days')::interval
        AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY time DESC
      LIMIT 10000
    `;
    if (raw.length < 2) return [];
    // Oldest -> newest for the boundary-crossing walk.
    const points = raw
      .map((r) => ({
        time: new Date(r.time),
        lat: Number(r.lat),
        lon: Number(r.lon),
      }))
      .reverse();

    // Home centroid — the most-visited ~0.1deg cell's mean position.
    const cells = new Map<
      string,
      { count: number; latSum: number; lonSum: number }
    >();
    for (const p of points) {
      const key = `${p.lat.toFixed(1)}|${p.lon.toFixed(1)}`;
      const c = cells.get(key) ?? { count: 0, latSum: 0, lonSum: 0 };
      c.count += 1;
      c.latSum += p.lat;
      c.lonSum += p.lon;
      cells.set(key, c);
    }
    const home = [...cells.values()].sort((a, b) => b.count - a.count)[0];
    const homeLat = home.latSum / home.count;
    const homeLon = home.lonSum / home.count;

    const geoShiftKm = await loadGeoShiftKm();

    const events: GeofenceEventRow[] = [];
    let id = 1;
    let inside: boolean | null = null;
    let tripViolated = false;
    const push = (
      type: GeofenceEventRow["event_type"],
      p: { time: Date; lat: number; lon: number },
      dist: number,
    ) => {
      events.push({
        id: id++,
        vehicleno,
        geofence_id: "home",
        event_type: type,
        event_time: p.time,
        lat: p.lat,
        lon: p.lon,
        distance_km: Math.round(dist * 10) / 10,
      });
    };

    for (const p of points) {
      const dist = haversineKm(p.lat, p.lon, homeLat, homeLon);
      const nowInside = dist <= GEOFENCE_HOME_RADIUS_KM;
      if (inside === null) {
        inside = nowInside;
        tripViolated = false;
        continue;
      }
      if (nowInside && !inside) {
        push("enter", p, dist);
        inside = true;
        tripViolated = false;
      } else if (!nowInside && inside) {
        push("exit", p, dist);
        inside = false;
        if (dist > geoShiftKm) {
          push("violation", p, dist);
          tripViolated = true;
        }
      } else if (!nowInside && !inside && dist > geoShiftKm && !tripViolated) {
        push("violation", p, dist);
        tripViolated = true;
      }
    }
    // Most-recent first for the drawer timeline.
    events.reverse();
    return events.slice(0, 200);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function getImmobilizerState(
  vehicleno: string,
  loanApplicationId?: string | null,
): Promise<ImmobilizerStateRow | null> {
  // Primary — VPS immobilizer_state: the iot_stack worker writes the
  // device-confirmed state here after a command executes (production path).
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        vehicleno: string;
        enabled: boolean;
        last_toggled_at: string | null;
        last_reason: string | null;
        last_request_id: string | null;
      }>
    >`
      SELECT vehicleno, enabled, last_toggled_at, last_reason, last_request_id
      FROM immobilizer_state
      WHERE vehicleno = ${vehicleno}
      LIMIT 1
    `;
    if (rows.length > 0) {
      const r = rows[0];
      return {
        vehicleno: r.vehicleno,
        enabled: r.enabled,
        last_toggled_at: r.last_toggled_at ? new Date(r.last_toggled_at) : null,
        last_reason: r.last_reason,
        last_request_id: r.last_request_id,
      };
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  // Fallback — the CRM immobilisation command log is the source of truth for
  // the immobilisation *intent*; the VPS table only confirms device execution.
  // Until the iot_stack worker populates the VPS table, read the latest
  // command for this loan so the card reflects reality.
  if (!loanApplicationId) return null;
  return immobilizerFromCrm(vehicleno, loanApplicationId);
}

/** Derives immobilizer state from the CRM nbfc_immobilisation_actions log. */
async function immobilizerFromCrm(
  vehicleno: string,
  loanApplicationId: string,
): Promise<ImmobilizerStateRow | null> {
  try {
    const rows = await db
      .select({
        iot_command_id: nbfcImmobilisationActions.iot_command_id,
        executed_at: nbfcImmobilisationActions.executed_at,
      })
      .from(nbfcImmobilisationActions)
      .where(
        eq(nbfcImmobilisationActions.loan_application_id, loanApplicationId),
      )
      .orderBy(desc(nbfcImmobilisationActions.executed_at))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      vehicleno,
      // nbfc_immobilisation_actions logs immobilise commands only (there are
      // no remobilise rows), so a logged executed action == currently
      // immobilised.
      enabled: r.executed_at != null,
      last_toggled_at: r.executed_at ?? null,
      last_reason: null,
      last_request_id: r.iot_command_id ?? null,
    };
  } catch {
    // A CRM hiccup must not blank the rest of the battery drawer.
    return null;
  }
}

export async function getChargeEvents(
  vehicleno: string,
  days: number,
): Promise<ChargeEventRow[]> {
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        id: string;
        vehicleno: string;
        start_time: string;
        end_time: string | null;
        start_soc_pct: string | null;
        end_soc_pct: string | null;
        energy_kwh: string | null;
        duration_s: number | null;
        charger_kind: string | null;
      }>
    >`
      SELECT id, vehicleno, start_time, end_time, start_soc_pct, end_soc_pct,
             energy_kwh, duration_s, charger_kind
      FROM charge_events
      WHERE vehicleno = ${vehicleno}
        AND start_time > NOW() - (${days}::int || ' days')::interval
      ORDER BY start_time DESC
      LIMIT 200
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      vehicleno: r.vehicleno,
      start_time: new Date(r.start_time),
      end_time: r.end_time ? new Date(r.end_time) : null,
      start_soc_pct: r.start_soc_pct != null ? Number(r.start_soc_pct) : null,
      end_soc_pct: r.end_soc_pct != null ? Number(r.end_soc_pct) : null,
      energy_kwh: r.energy_kwh != null ? Number(r.energy_kwh) : null,
      duration_s: r.duration_s,
      charger_kind: r.charger_kind,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function getOpenFaultCodes(
  vehicleno: string,
): Promise<FaultCodeRow[]> {
  // Primary — VPS fault_codes (production aggregator path).
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        id: string;
        vehicleno: string;
        dtc_code: string;
        description: string | null;
        severity: "info" | "warning" | "critical";
        raised_at: string;
        resolved_at: string | null;
      }>
    >`
      SELECT id, vehicleno, dtc_code, description, severity, raised_at, resolved_at
      FROM fault_codes
      WHERE vehicleno = ${vehicleno}
        AND resolved_at IS NULL
      ORDER BY raised_at DESC
      LIMIT 50
    `;
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: Number(r.id),
        vehicleno: r.vehicleno,
        dtc_code: r.dtc_code,
        description: r.description,
        severity: r.severity,
        raised_at: new Date(r.raised_at),
        resolved_at: r.resolved_at ? new Date(r.resolved_at) : null,
      }));
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  // Fallback — derive currently-open faults from recent telemetry_can BMS
  // packets: every *_alarm / *_protection flag set non-zero in the last 24h.
  return deriveOpenFaultsFromCan(vehicleno);
}

/** Humanises a CAN BMS alarm/protection field name into a DTC-style fault. */
function describeCanFault(field: string): {
  code: string;
  description: string;
  severity: "warning" | "critical";
} {
  const isProtection = /protection$/i.test(field);
  const base = field.replace(/_(alarms?|protection)$/i, "");
  const words = base.replace(/_/g, " ");
  return {
    code: base.toUpperCase(),
    description:
      words.charAt(0).toUpperCase() +
      words.slice(1) +
      (isProtection ? " — protection tripped" : " alarm"),
    // A tripped protection means the BMS cut the pack — critical. A bare
    // alarm flag is a warning.
    severity: isProtection ? "critical" : "warning",
  };
}

/**
 * Derives open faults from the last 24h of telemetry_can BMS flags. A BMS
 * alarm flag is instantaneous (set in the packets where the condition holds),
 * so a fault is treated as "open" when its flag is non-zero in any packet in
 * the window — raised_at is the most recent such packet. telemetry_can is
 * sparse (~15 packets/day) so the window is only a handful of rows.
 */
async function deriveOpenFaultsFromCan(
  vehicleno: string,
): Promise<FaultCodeRow[]> {
  try {
    const iotSql = getIotSql();
    const rows = await iotSql<
      Array<{
        time: string;
        payload: Record<string, { value?: unknown; timestamp?: number }>;
      }>
    >`
      SELECT time, payload
      FROM telemetry_can
      WHERE vehicleno = ${vehicleno}
        AND time > NOW() - INTERVAL '24 hours'
      ORDER BY time DESC
    `;
    if (rows.length === 0) return [];

    // One fault per BMS condition (e.g. "cell_over_voltage"). The BMS exposes
    // both an `_alarm` (warning threshold) and a `_protection` (cutoff) flag
    // per condition — a tripped protection supersedes the bare alarm, so we
    // keep the most severe. Rows are time-DESC, so the first hit is the latest.
    const byCondition = new Map<string, { field: string; at: Date }>();
    for (const row of rows) {
      for (const [field, raw] of Object.entries(row.payload ?? {})) {
        // Discrete alarm/protection flags only — skip *_count / occurence_count.
        if (!/_(alarms?|protection)$/i.test(field)) continue;
        const value = Number(raw?.value ?? 0);
        if (!Number.isFinite(value) || value === 0) continue;
        const base = field.replace(/_(alarms?|protection)$/i, "");
        const existing = byCondition.get(base);
        const isProtection = /protection$/i.test(field);
        if (existing) {
          const existingIsProtection = /protection$/i.test(existing.field);
          // Keep existing unless we are upgrading alarm -> protection.
          if (existingIsProtection || !isProtection) continue;
        }
        const ts = Number(raw?.timestamp);
        byCondition.set(base, {
          field,
          at: Number.isFinite(ts) ? new Date(ts) : new Date(row.time),
        });
      }
    }

    const faults: FaultCodeRow[] = [];
    let idx = 1;
    for (const { field, at } of byCondition.values()) {
      const meta = describeCanFault(field);
      faults.push({
        id: idx++,
        vehicleno,
        dtc_code: meta.code,
        description: meta.description,
        severity: meta.severity,
        raised_at: at,
        resolved_at: null,
      });
    }
    // Critical (tripped protections) first.
    faults.sort(
      (a, b) =>
        (a.severity === "critical" ? 0 : 1) -
        (b.severity === "critical" ? 0 : 1),
    );
    return faults;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * Open alerts for a vehicleno set.
 */
export async function getOpenAlerts(vehiclenos: string[]): Promise<OpenAlert[]> {
  if (vehiclenos.length === 0) return [];
  const iotSql = getIotSql();
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
