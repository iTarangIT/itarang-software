/**
 * Telemetry queries for the Intellicar dashboard (Fleet Overview, Trips,
 * Health, Alerts, Devices, Database tabs at /ceo/intellicar).
 *
 * Reads fleet telemetry from the VPS TimescaleDB (vehicle_state, vehicles,
 * telemetry_*, alerts, distance_rollup, trips) via getIotSql(). Reads/writes
 * dealer↔vehicle deployment mappings on the main CRM RDS via the `db` client.
 * Cross-DB joins (e.g. enriching VPS alerts with RDS dealer info) happen in
 * this process — the two databases are not federated.
 *
 * Output shapes preserve the legacy column names the React components expect,
 * so the UI does not change:
 *   vehicleno  → device_id, vehicle_number
 *   soc_pct    → soc
 *   soh_pct    → soh
 *   lat / lon  → latitude, longitude
 *   time       → recorded_at  (or created_at on alerts)
 */
import { getIotSql } from "@/lib/db/iot";
import { db } from "@/lib/db";
import { deviceBatteryMap } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

// ─── Fleet Dashboard ─────────────────────────────────────────────────────────

function emptyFleetDashboardCEO() {
    return {
        role: "ceo" as const,
        kpis: {
            fleetSize: 0,
            utilization: 0,
            avgSOH: 0,
            warrantyAtRisk: 0,
            activeAlerts: 0,
        },
        warrantyRisk: { trend: [] as unknown[], atRiskDevices: 0 },
        dealerPerformance: [] as unknown[],
        serviceMetrics: { fleetUptime: 0, avgDailyDistance: 0, offlineDevices: 0 },
    };
}

export async function fetchFleetDashboardCEO(filter?: { state?: string; city?: string }) {
    const iot = getIotSql();

    // Location filter → resolve the matching vehicle numbers from the RDS
    // mapping and scope every VPS query to that set (same VPS↔RDS bridge as the
    // dealer path). No filter → whole fleet. Empty set → zeroed KPIs.
    let vehicleNos: string[] | null = null;
    if (filter?.state || filter?.city) {
        vehicleNos = await vehicleNumbersByLocation(filter.state, filter.city);
        if (vehicleNos.length === 0) return emptyFleetDashboardCEO();
    }
    const stateWhere = vehicleNos ? iot`WHERE vehicleno = ANY(${vehicleNos})` : iot``;
    const locAnd = vehicleNos ? iot`AND vehicleno = ANY(${vehicleNos})` : iot``;

    const [stats] = await iot`
        SELECT
            count(*)::int                                                       AS fleet_size,
            count(*) FILTER (WHERE online)::int                                 AS active_now,
            round(avg(soh_pct)::numeric, 1)::float                              AS avg_soh,
            count(*) FILTER (WHERE soh_pct IS NOT NULL AND soh_pct < 80)::int   AS warranty_at_risk
        FROM vehicle_state
        ${stateWhere}
    `;

    const [alertCount] = await iot`
        SELECT count(*)::int AS active_alerts
        FROM alerts
        WHERE resolved_at IS NULL ${locAnd}
    `;

    const sohTrend = await iot`
        SELECT
            date_trunc('day', time)::date          AS date,
            round(avg(soh_pct)::numeric, 1)::float AS avg_soh
        FROM telemetry_battery
        WHERE time > now() - interval '30 days' AND soh_pct IS NOT NULL ${locAnd}
        GROUP BY 1
        ORDER BY 1
    `;

    // Unfiltered path uses the fleet-wide distance_rollup (no vehicleno column).
    // A location filter can't scope distance_rollup, so derive the same 7-day
    // average per-vehicle from daily_distance_per_vehicle(day, vehicleno, km).
    const [distance] = vehicleNos
        ? await iot`
            SELECT round(avg(km)::numeric, 1)::float AS avg_daily_km
            FROM daily_distance_per_vehicle
            WHERE day > (now() - interval '7 days')::date
              AND vehicleno = ANY(${vehicleNos})
        `
        : await iot`
            SELECT round(avg(distance_km)::numeric, 1)::float AS avg_daily_km
            FROM distance_rollup
            WHERE time > now() - interval '7 days'
        `;

    const fleetSize = Number(stats?.fleet_size) || 0;
    const activeNow = Number(stats?.active_now) || 0;
    const utilization =
        fleetSize > 0 ? Math.round((activeNow / fleetSize) * 100) : 0;

    return {
        role: "ceo" as const,
        kpis: {
            fleetSize,
            utilization,
            avgSOH: Number(stats?.avg_soh) || 0,
            warrantyAtRisk: Number(stats?.warranty_at_risk) || 0,
            activeAlerts: Number(alertCount?.active_alerts) || 0,
        },
        warrantyRisk: {
            trend: sohTrend,
            atRiskDevices: Number(stats?.warranty_at_risk) || 0,
        },
        dealerPerformance: await fetchDealerPerformanceInner(filter),
        serviceMetrics: {
            fleetUptime: utilization,
            avgDailyDistance: Number(distance?.avg_daily_km) || 0,
            offlineDevices: fleetSize - activeNow,
        },
    };
}

export async function fetchFleetDashboardDealer(dealerId: string) {
    const vehicleNos = await dealerVehicleNumbers(dealerId);
    if (vehicleNos.length === 0) {
        return {
            role: "dealer" as const,
            kpis: {
                vehicleCount: 0,
                avgSOC: 0,
                faultyDevices: 0,
                activeToday: 0,
                energy24h: 0,
            },
        };
    }

    const iot = getIotSql();
    const [stats] = await iot`
        SELECT
            count(*)::int                                                                    AS vehicle_count,
            round(avg(soc_pct)::numeric, 1)::float                                           AS avg_soc,
            count(*) FILTER (WHERE soh_pct IS NOT NULL AND soh_pct < 80)::int                AS faulty_devices,
            count(*) FILTER (WHERE last_gps_at IS NOT NULL
                             AND last_gps_at > now() - interval '24 hours')::int             AS active_today
        FROM vehicle_state
        WHERE vehicleno = ANY(${vehicleNos})
    `;

    return {
        role: "dealer" as const,
        kpis: {
            vehicleCount: Number(stats?.vehicle_count) || 0,
            avgSOC: Number(stats?.avg_soc) || 0,
            faultyDevices: Number(stats?.faulty_devices) || 0,
            activeToday: Number(stats?.active_today) || 0,
            energy24h: 0,
        },
    };
}

/**
 * Distinct States and their Cities from the RDS `device_battery_map`, for the
 * Fleet Overview filter dropdowns. Dealer-scoped when a dealerId is given.
 * Returns states sorted, plus a state→cities map (cities sorted).
 */
export async function fetchFleetLocations(dealerId?: string): Promise<{
    states: string[];
    citiesByState: Record<string, string[]>;
}> {
    const conds = [
        eq(deviceBatteryMap.status, "active"),
        isNotNull(deviceBatteryMap.state),
    ];
    if (dealerId) conds.push(eq(deviceBatteryMap.dealer_id, dealerId));

    const rows = await db
        .selectDistinct({
            state: deviceBatteryMap.state,
            city: deviceBatteryMap.city,
        })
        .from(deviceBatteryMap)
        .where(and(...conds));

    const citiesByState: Record<string, Set<string>> = {};
    for (const r of rows) {
        const state = r.state?.trim();
        if (!state) continue;
        (citiesByState[state] ??= new Set<string>());
        const city = r.city?.trim();
        if (city) citiesByState[state].add(city);
    }

    const states = Object.keys(citiesByState).sort();
    const out: Record<string, string[]> = {};
    for (const s of states) out[s] = Array.from(citiesByState[s]).sort();
    return { states, citiesByState: out };
}

// ─── Fleet Map / Devices ─────────────────────────────────────────────────────

export async function fetchFleetMapData(opts?: {
    dealerId?: string;
    state?: string;
    city?: string;
}) {
    const iot = getIotSql();
    const { dealerId, state, city } = opts ?? {};

    // Dealer scope and/or location filter both narrow to a vehicle-number set
    // resolved from the RDS mapping; combine them in one lookup.
    let vehicleNos: string[] | null = null;
    if (dealerId || state || city) {
        vehicleNos = await vehicleNumbersByLocation(state, city, dealerId);
        if (vehicleNos.length === 0) return [];
    }
    const locWhere = vehicleNos ? iot`WHERE vs.vehicleno = ANY(${vehicleNos})` : iot``;

    return iot`
        SELECT
            vs.vehicleno   AS device_id,
            vs.vehicleno   AS vehicle_number,
            v.makemodel    AS customer_name,
            vs.soc_pct     AS soc,
            vs.soh_pct     AS soh,
            vs.last_battery_at AS battery_updated_at,
            vs.lat         AS latitude,
            vs.lon         AS longitude,
            vs.last_gps_at AS gps_updated_at,
            CASE
                WHEN vs.open_alert_count > 0 THEN 'critical'
                WHEN NOT vs.online            THEN 'offline'
                -- Device (GPS) is online but the battery/BMS is silent — stale or
                -- missing CAN telemetry. Don't let these read as Healthy.
                WHEN vs.last_battery_at IS NULL
                  OR vs.last_battery_at < now() - interval '24 hours'
                  OR vs.soc_pct IS NULL
                  OR vs.soh_pct IS NULL       THEN 'disconnected'
                ELSE 'healthy'
            END            AS status
        FROM vehicle_state vs
        LEFT JOIN vehicles v USING (vehicleno)
        ${locWhere}
        ORDER BY vs.last_seen DESC NULLS LAST
    `;
}

export async function fetchDevices(limit = 50, offset = 0, dealerId?: string) {
    const iot = getIotSql();
    const dealerVehicleNos = dealerId ? await dealerVehicleNumbers(dealerId) : null;
    if (dealerVehicleNos && dealerVehicleNos.length === 0) return [];

    if (dealerVehicleNos) {
        return iot`
            SELECT
                vs.vehicleno   AS device_id,
                vs.vehicleno   AS vehicle_number,
                v.makemodel    AS vehicle_type,
                v.owner        AS customer_name,
                vs.soc_pct     AS soc,
                vs.soh_pct     AS soh,
                vs.last_battery_at AS last_reading_at,
                vs.last_gps_at AS last_gps_at,
                vs.online,
                vs.open_alert_count
            FROM vehicle_state vs
            LEFT JOIN vehicles v USING (vehicleno)
            WHERE vs.vehicleno = ANY(${dealerVehicleNos})
            ORDER BY vs.last_seen DESC NULLS LAST
            LIMIT ${limit} OFFSET ${offset}
        `;
    }

    return iot`
        SELECT
            vs.vehicleno   AS device_id,
            vs.vehicleno   AS vehicle_number,
            v.makemodel    AS vehicle_type,
            v.owner        AS customer_name,
            vs.soc_pct     AS soc,
            vs.soh_pct     AS soh,
            vs.last_battery_at AS last_reading_at,
            vs.last_gps_at AS last_gps_at,
            vs.online,
            vs.open_alert_count
        FROM vehicle_state vs
        LEFT JOIN vehicles v USING (vehicleno)
        ORDER BY vs.last_seen DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
    `;
}

export async function fetchDeviceById(deviceId: string) {
    const iot = getIotSql();
    const [row] = await iot`
        SELECT
            vs.vehicleno   AS device_id,
            vs.vehicleno   AS vehicle_number,
            v.makemodel    AS vehicle_type,
            v.owner        AS customer_name,
            vs.soc_pct     AS soc,
            vs.soh_pct     AS soh,
            vs.pack_voltage AS voltage,
            vs.pack_current AS current_val,
            vs.pack_temp_c  AS temperature,
            vs.last_battery_at AS last_reading_at,
            vs.lat         AS latitude,
            vs.lon         AS longitude,
            vs.speed_kph   AS speed,
            vs.last_gps_at AS last_gps_at,
            vs.online,
            vs.open_alert_count
        FROM vehicle_state vs
        LEFT JOIN vehicles v USING (vehicleno)
        WHERE vs.vehicleno = ${deviceId}
    `;
    return row || null;
}

export async function fetchDeviceReadings(deviceId: string, hours = 24) {
    const iot = getIotSql();
    return iot`
        SELECT
            soc_pct      AS soc,
            soh_pct      AS soh,
            pack_voltage AS voltage,
            pack_current AS current_val,
            pack_temp_c  AS temperature,
            time         AS recorded_at
        FROM telemetry_battery
        WHERE vehicleno = ${deviceId}
          AND time > now() - (interval '1 hour' * ${hours})
        ORDER BY time ASC
    `;
}

export async function fetchDeviceGPS(deviceId: string, hours = 24) {
    const iot = getIotSql();
    return iot`
        SELECT
            lat       AS latitude,
            lon       AS longitude,
            speed_kph AS speed,
            heading,
            time      AS recorded_at
        FROM telemetry_gps
        WHERE vehicleno = ${deviceId}
          AND time > now() - (interval '1 hour' * ${hours})
        ORDER BY time ASC
    `;
}

export async function fetchDeviceTrips(deviceId: string, limit = 20) {
    const iot = getIotSql();
    return iot`
        SELECT
            vehicleno AS device_id,
            trip_id,
            time      AS start_time,
            end_time,
            start_lat,
            start_lon,
            end_lat,
            end_lon,
            distance_km,
            duration_s,
            energy_kwh,
            avg_speed_kph
        FROM trips
        WHERE vehicleno = ${deviceId}
        ORDER BY time DESC
        LIMIT ${limit}
    `;
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

// Synthetic id format used by the UI's ack button: <vehicleno>|<alert_type>|<epoch_seconds>
function buildAlertId(row: { vehicleno: unknown; alert_type: unknown; time: unknown }) {
    const t =
        row.time instanceof Date
            ? Math.floor(row.time.getTime() / 1000)
            : Math.floor(new Date(String(row.time)).getTime() / 1000);
    return `${String(row.vehicleno)}|${String(row.alert_type)}|${t}`;
}

function parseAlertId(alertId: string) {
    const [vehicleno, alertType, epochStr] = alertId.split("|");
    const epoch = Number(epochStr);
    if (!vehicleno || !alertType || !Number.isFinite(epoch)) {
        throw new Error(
            "Malformed alertId. Expected '<vehicleno>|<alert_type>|<epoch_seconds>'.",
        );
    }
    return { vehicleno, alertType, time: new Date(epoch * 1000) };
}

export async function fetchAlerts(
    limit = 50,
    acknowledged?: boolean,
    dealerId?: string,
) {
    const iot = getIotSql();
    const dealerVehicleNos = dealerId ? await dealerVehicleNumbers(dealerId) : null;
    if (dealerVehicleNos && dealerVehicleNos.length === 0) return [];

    const ackPredicate =
        acknowledged === true
            ? iot`AND resolved_at IS NOT NULL`
            : acknowledged === false
              ? iot`AND resolved_at IS NULL`
              : iot``;
    const dealerPredicate = dealerVehicleNos
        ? iot`AND vehicleno = ANY(${dealerVehicleNos})`
        : iot``;

    const rows = await iot`
        SELECT
            vehicleno     AS device_id,
            vehicleno     AS vehicle_number,
            alert_type,
            severity,
            message,
            value,
            threshold,
            time          AS created_at,
            resolved_at,
            (resolved_at IS NOT NULL) AS acknowledged
        FROM alerts
        WHERE 1=1 ${ackPredicate} ${dealerPredicate}
        ORDER BY time DESC
        LIMIT ${limit}
    `;

    if (rows.length === 0) return [];

    // Enrich with dealer_id / customer_name from RDS device_battery_map (same VPS↔RDS bridge).
    const vehicleNos = Array.from(
        new Set(rows.map((r) => String(r.device_id)).filter(Boolean)),
    );
    const mappings = await db
        .select({
            vehicle_number: deviceBatteryMap.vehicle_number,
            dealer_id: deviceBatteryMap.dealer_id,
            customer_name: deviceBatteryMap.customer_name,
        })
        .from(deviceBatteryMap)
        .where(inArray(deviceBatteryMap.vehicle_number, vehicleNos));
    const byVehicle = new Map(
        mappings
            .filter((m) => m.vehicle_number)
            .map((m) => [m.vehicle_number as string, m]),
    );

    return rows.map((r) => {
        const m = byVehicle.get(String(r.device_id));
        return {
            ...r,
            id: buildAlertId({
                vehicleno: r.device_id,
                alert_type: r.alert_type,
                time: r.created_at,
            }),
            dealer_id: m?.dealer_id ?? null,
            customer_name: m?.customer_name ?? null,
        };
    });
}

export async function acknowledgeAlert(alertId: string, _acknowledgedBy: string) {
    // The VPS `alerts` table has no acknowledged_by column — it tracks
    // resolution via `resolved_at`. We accept the parameter for API compat
    // and discard it. The audit trail (who acked) is the caller's responsibility.
    void _acknowledgedBy;
    const { vehicleno, alertType, time } = parseAlertId(alertId);
    const iot = getIotSql();
    return iot`
        UPDATE alerts
        SET resolved_at = now()
        WHERE vehicleno = ${vehicleno}
          AND alert_type = ${alertType}
          AND time = ${time.toISOString()}
          AND resolved_at IS NULL
    `;
}

export async function fetchAlertConfig() {
    // No alert_config table on the VPS — alerts are produced by the iot_stack
    // poller using thresholds defined in iot_stack/poller/poll.py. Return
    // empty so the UI hides the configuration card.
    return [] as Array<Record<string, unknown>>;
}

export async function updateAlertConfig(
    _alertType: string,
    _threshold: number,
    _severity: string,
) {
    void _alertType;
    void _threshold;
    void _severity;
    throw new Error(
        "Alert thresholds are configured in iTarangIT/iot_stack (poller/poll.py), not in the CRM. Update them there and redeploy the poller.",
    );
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function fetchSOHTrend(days = 30) {
    const iot = getIotSql();
    return iot`
        SELECT
            date_trunc('day', time)::date          AS date,
            round(avg(soh_pct)::numeric, 1)::float AS avg_soh,
            round(min(soh_pct)::numeric, 1)::float AS min_soh,
            round(max(soh_pct)::numeric, 1)::float AS max_soh
        FROM telemetry_battery
        WHERE time > now() - (interval '1 day' * ${days})
          AND soh_pct IS NOT NULL
        GROUP BY 1
        ORDER BY 1
    `;
}

export async function fetchSOCTrends(days = 30) {
    const iot = getIotSql();
    return iot`
        SELECT
            date_trunc('day', time)::date          AS date,
            round(avg(soc_pct)::numeric, 1)::float AS avg_soc,
            round(min(soc_pct)::numeric, 1)::float AS min_soc,
            round(max(soc_pct)::numeric, 1)::float AS max_soc
        FROM telemetry_battery
        WHERE time > now() - (interval '1 day' * ${days})
          AND soc_pct IS NOT NULL
        GROUP BY 1
        ORDER BY 1
    `;
}

/**
 * Amp-Hour (AH) analytics for one battery over the last N months, computed
 * on-demand from VPS `telemetry_battery`.
 *
 * NOTE: the VPS `charging` boolean is never populated (always NULL) in this
 * feed, so charging can't be read from a flag. We detect it from **rising SOC**
 * instead — the reliable available signal (soc_pct + pack_current + time).
 *
 * Method (coulomb counting):
 *   1. Order samples by time; compute Δsoc and Δt against the previous sample.
 *   2. A charging session = a contiguous run where SOC is non-decreasing
 *      (Δsoc ≥ 0) and the gap is ≤ 20 min. Any SOC drop (discharge/drive) or a
 *      longer gap ends the session.
 *   3. AH is integrated only over the rising steps: Σ |pack_current| × Δt(h).
 *      |·| guards the unknown charge-current sign convention; current is present
 *      in ~97% of rising steps.
 *   4. Keep sessions with net SOC gain ≥ 5 and AH > 0. start/end SOC = min/max.
 *   5. Extrapolate full (100%) capacity: ah_charged ÷ (Δsoc/100).
 */
export async function fetchBatteryAhAnalytics(
    vehicleno: string,
    opts: { months?: number; month?: string },
) {
    const iot = getIotSql();

    // Time window: a specific calendar month (YYYY-MM) when `month` is given,
    // otherwise the last N months relative to now (1 / 3 / 6).
    let timePredicate;
    let months: number | null = null;
    let month: string | null = null;
    if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
        month = opts.month;
        const [y, mo] = opts.month.split("-").map(Number);
        const start = `${opts.month}-01`;
        const next =
            mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
        timePredicate = iot`AND time >= ${start} AND time < ${`${next}-01`}`;
    } else {
        months = [1, 3, 6].includes(opts.months ?? 3) ? (opts.months ?? 3) : 3;
        timePredicate = iot`AND time > now() - (interval '1 month' * ${months})`;
    }

    // Battery telemetry lives in telemetry_can as a JSONB `payload` — the AWS poller
    // writes SOC / current / voltage there, NOT into the legacy telemetry_battery table
    // (which is frozen at the VPS-migration cutover). Extract soc + pack current from the
    // payload, then coulomb-count exactly as before. Payload keys of interest:
    //   payload->'soc'->>'value'      integer %  (0..100)
    //   payload->'current'->>'value'  pack current in A (sign varies; ABS used below)
    //   payload->'rated_capacity'->>'value'  nameplate Ah (e.g. 105)
    const rows = (await iot`
        WITH raw AS (
            SELECT
                time,
                (payload->'soc'->>'value')::float      AS soc_pct,
                (payload->'current'->>'value')::float  AS pack_current
            FROM telemetry_can
            WHERE vehicleno = ${vehicleno}
              AND payload->'soc'->>'value' IS NOT NULL
              ${timePredicate}
        ),
        samples AS (
            SELECT
                time,
                soc_pct,
                pack_current,
                soc_pct - LAG(soc_pct) OVER w                          AS dsoc,
                EXTRACT(EPOCH FROM (time - LAG(time) OVER w))          AS dt_s
            FROM raw
            WINDOW w AS (ORDER BY time)
        ),
        flagged AS (
            SELECT *,
                CASE WHEN dsoc >= 0 AND dt_s IS NOT NULL AND dt_s <= 1200 THEN 1 ELSE 0 END AS in_sess
            FROM samples
        ),
        grouped AS (
            SELECT *,
                SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id
            FROM flagged
        )
        SELECT
            min(time)                                                        AS start_time,
            max(time) FILTER (WHERE dsoc > 0)                                AS end_time,
            EXTRACT(EPOCH FROM (max(time) FILTER (WHERE dsoc > 0) - min(time)))::int AS duration_s,
            round(sum(CASE WHEN dsoc > 0 AND pack_current IS NOT NULL
                           THEN ABS(pack_current) * (dt_s / 3600.0)
                           ELSE 0 END)::numeric, 2)::float                   AS ah_charged,
            min(soc_pct)::float                                              AS start_soc,
            max(soc_pct)::float                                              AS end_soc,
            -- SOC gained specifically over the steps that had a current reading;
            -- pairing this with ah_charged makes the capacity estimate robust to
            -- sparse current coverage within a session.
            round(sum(dsoc) FILTER (WHERE dsoc > 0 AND pack_current IS NOT NULL)::numeric, 1)::float AS soc_measured
        FROM grouped
        WHERE in_sess = 1
        GROUP BY break_id
        HAVING (max(soc_pct) - min(soc_pct)) >= 5
           AND sum(CASE WHEN dsoc > 0 AND pack_current IS NOT NULL
                        THEN ABS(pack_current) * (dt_s / 3600.0)
                        ELSE 0 END) > 0
        ORDER BY start_time ASC
    `) as Array<{
        start_time: Date;
        end_time: Date;
        duration_s: number | null;
        ah_charged: number | null;
        start_soc: number | null;
        end_soc: number | null;
        soc_measured: number | null;
    }>;

    const sessions = rows.map((r) => {
        const startSoc = r.start_soc != null ? Number(r.start_soc) : null;
        const endSoc = r.end_soc != null ? Number(r.end_soc) : null;
        const ah = Number(r.ah_charged) || 0;
        // Extrapolate full (100%) capacity from the AH added over the measured SOC gain:
        //   capacity = ah / (ΔSOC/100).
        // Only trust this when the coulomb-counted current spans a LARGE swing (>= 50%
        // SOC). A small top-up (e.g. 5%) extrapolated x20 amplifies noise; a >= 50% swing
        // is at most a x2 extrapolation, so the estimate is reliable. Cycles below the
        // threshold still appear in the AH trend but contribute no capacity point.
        const socMeasured = r.soc_measured != null ? Number(r.soc_measured) : null;
        const capacity =
            socMeasured != null && socMeasured >= 50
                ? Math.round((ah / (socMeasured / 100)) * 10) / 10
                : null;
        return {
            start_time: r.start_time,
            end_time: r.end_time,
            duration_s: Number(r.duration_s) || 0,
            ah_charged: Math.round(ah * 100) / 100,
            start_soc: startSoc,
            end_soc: endSoc,
            estimated_capacity_ah: capacity,
        };
    });

    const cycles = sessions.length;
    const totalAh = sessions.reduce((s, r) => s + r.ah_charged, 0);
    const caps = sessions
        .map((r) => r.estimated_capacity_ah)
        .filter((v): v is number => v != null);
    const socGains = sessions
        .map((r) =>
            r.start_soc != null && r.end_soc != null
                ? r.end_soc - r.start_soc
                : null,
        )
        .filter((v): v is number => v != null);
    const avg = (arr: number[]) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
        vehicleno,
        months,
        month,
        sessions,
        summary: {
            chargingCycles: cycles,
            totalAhCharged: Math.round(totalAh * 10) / 10,
            avgAhPerSession: Math.round(avg(sessions.map((r) => r.ah_charged)) * 10) / 10,
            avgCapacityAh: caps.length ? Math.round(avg(caps) * 10) / 10 : null,
            avgSessionDurationMin:
                Math.round(avg(sessions.map((r) => r.duration_s)) / 60 * 10) / 10,
            avgSocGained: Math.round(avg(socGains) * 10) / 10,
        },
    };
}

export async function fetchWarrantyRisk() {
    const iot = getIotSql();
    const rows = await iot`
        SELECT
            vs.vehicleno    AS device_id,
            vs.vehicleno    AS vehicle_number,
            vs.soh_pct      AS soh,
            vs.last_battery_at AS last_reading,
            v.owner         AS customer_name
        FROM vehicle_state vs
        LEFT JOIN vehicles v USING (vehicleno)
        WHERE vs.soh_pct IS NOT NULL AND vs.soh_pct < 80
        ORDER BY vs.soh_pct ASC
    `;

    if (rows.length === 0) return [];
    const vehicleNos = Array.from(
        new Set(rows.map((r) => String(r.device_id)).filter(Boolean)),
    );
    const mappings = await db
        .select({
            vehicle_number: deviceBatteryMap.vehicle_number,
            dealer_id: deviceBatteryMap.dealer_id,
            customer_name: deviceBatteryMap.customer_name,
        })
        .from(deviceBatteryMap)
        .where(inArray(deviceBatteryMap.vehicle_number, vehicleNos));
    const byVehicle = new Map(
        mappings
            .filter((m) => m.vehicle_number)
            .map((m) => [m.vehicle_number as string, m]),
    );

    return rows.map((r) => {
        const m = byVehicle.get(String(r.device_id));
        return {
            ...r,
            dealer_id: m?.dealer_id ?? null,
            customer_name: m?.customer_name ?? r.customer_name ?? null,
        };
    });
}

export async function fetchDealerComparison() {
    return fetchDealerPerformanceInner();
}

async function fetchDealerPerformanceInner(filter?: { state?: string; city?: string }) {
    const conds = [
        eq(deviceBatteryMap.status, "active"),
        isNotNull(deviceBatteryMap.dealer_id),
        isNotNull(deviceBatteryMap.vehicle_number),
    ];
    if (filter?.state) conds.push(eq(deviceBatteryMap.state, filter.state));
    if (filter?.city) conds.push(eq(deviceBatteryMap.city, filter.city));

    const mappings = await db
        .select({
            dealer_id: deviceBatteryMap.dealer_id,
            vehicle_number: deviceBatteryMap.vehicle_number,
        })
        .from(deviceBatteryMap)
        .where(and(...conds));

    if (mappings.length === 0) return [];

    const vehicleNos = mappings
        .map((m) => m.vehicle_number)
        .filter((v): v is string => !!v);

    const iot = getIotSql();
    const states = await iot`
        SELECT
            vehicleno,
            soc_pct,
            soh_pct,
            open_alert_count
        FROM vehicle_state
        WHERE vehicleno = ANY(${vehicleNos})
    `;

    type StateRow = {
        vehicleno: string;
        soc_pct: number | null;
        soh_pct: number | null;
        open_alert_count: number | null;
    };
    const stateByVehicle = new Map<string, StateRow>(
        (states as unknown as StateRow[]).map((s) => [s.vehicleno, s]),
    );

    type Agg = {
        dealer_id: string;
        devices: number;
        sohSum: number;
        sohCount: number;
        socSum: number;
        socCount: number;
        alerts: number;
    };
    const byDealer = new Map<string, Agg>();
    for (const m of mappings) {
        const dealer = m.dealer_id;
        const vehicle = m.vehicle_number;
        if (!dealer || !vehicle) continue;
        const state = stateByVehicle.get(vehicle);
        if (!state) continue;
        const agg = byDealer.get(dealer) ?? {
            dealer_id: dealer,
            devices: 0,
            sohSum: 0,
            sohCount: 0,
            socSum: 0,
            socCount: 0,
            alerts: 0,
        };
        agg.devices += 1;
        if (state.soh_pct != null) {
            agg.sohSum += Number(state.soh_pct);
            agg.sohCount += 1;
        }
        if (state.soc_pct != null) {
            agg.socSum += Number(state.soc_pct);
            agg.socCount += 1;
        }
        if (Number(state.open_alert_count) > 0) agg.alerts += 1;
        byDealer.set(dealer, agg);
    }

    return Array.from(byDealer.values())
        .map((a) => ({
            dealer_id: a.dealer_id,
            devices: a.devices,
            device_count: a.devices,
            avg_soh:
                a.sohCount > 0 ? Math.round((a.sohSum / a.sohCount) * 10) / 10 : 0,
            avg_soc:
                a.socCount > 0 ? Math.round((a.socSum / a.socCount) * 10) / 10 : 0,
            alerts: a.alerts,
            alert_count: a.alerts,
        }))
        .sort((a, b) => b.devices - a.devices);
}

export async function fetchTripsOverview(limit = 50) {
    const iot = getIotSql();
    return iot`
        SELECT
            t.vehicleno    AS device_id,
            t.vehicleno    AS vehicle_number,
            v.owner        AS customer_name,
            t.trip_id,
            t.time         AS start_time,
            t.end_time,
            t.start_lat,
            t.start_lon,
            t.end_lat,
            t.end_lon,
            t.distance_km,
            t.duration_s,
            t.energy_kwh,
            t.avg_speed_kph
        FROM trips t
        LEFT JOIN vehicles v USING (vehicleno)
        ORDER BY t.time DESC
        LIMIT ${limit}
    `;
}

// ─── Device Mapping (RDS-side, dealer onboarding) ────────────────────────────

export async function createDeviceMapping(data: {
    id: string;
    device_id: string;
    battery_serial?: string;
    vehicle_number?: string;
    vehicle_type?: string;
    customer_name?: string;
    customer_phone?: string;
    dealer_id?: string;
    state?: string;
    city?: string;
}) {
    return db.insert(deviceBatteryMap).values({
        id: data.id,
        device_id: data.device_id,
        battery_serial: data.battery_serial || null,
        vehicle_number: data.vehicle_number || null,
        vehicle_type: data.vehicle_type || null,
        customer_name: data.customer_name || null,
        customer_phone: data.customer_phone || null,
        dealer_id: data.dealer_id || null,
        state: data.state || null,
        city: data.city || null,
        status: "active",
    });
}

export async function updateDeviceMapping(
    deviceId: string,
    data: Record<string, unknown>,
) {
    const allowed = [
        "battery_serial",
        "vehicle_number",
        "vehicle_type",
        "customer_name",
        "customer_phone",
        "dealer_id",
        "state",
        "city",
        "status",
    ] as const;
    type Allowed = (typeof allowed)[number];
    const patch: Partial<Record<Allowed, unknown>> = {};
    for (const key of allowed) {
        if (data[key] !== undefined) patch[key] = data[key];
    }
    if (Object.keys(patch).length === 0) return;
    return db
        .update(deviceBatteryMap)
        .set({ ...patch, updated_at: new Date() })
        .where(eq(deviceBatteryMap.device_id, deviceId));
}

// ─── System / Database Monitor ───────────────────────────────────────────────

export async function fetchDatabaseStats() {
    const iot = getIotSql();
    return iot`
        SELECT
            schemaname AS schema,
            relname    AS table_name,
            n_live_tup AS row_count,
            pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS total_size
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
        ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
    `;
}

export async function fetchDeviceStatus() {
    const iot = getIotSql();
    return iot`
        SELECT
            vehicleno    AS device_id,
            vehicleno    AS vehicle_number,
            CASE WHEN online THEN 'active' ELSE 'inactive' END AS status,
            last_battery_at AS last_can_at,
            last_gps_at,
            CASE
                WHEN last_gps_at IS NULL                                   THEN 'offline'
                WHEN last_gps_at > now() - interval '1 hour'               THEN 'online'
                WHEN last_gps_at > now() - interval '24 hours'             THEN 'intermittent'
                ELSE 'offline'
            END AS comm_status
        FROM vehicle_state
        ORDER BY last_seen DESC NULLS LAST
    `;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resolve a dealer's vehicle registration numbers from the RDS-side
 * `device_battery_map`. Returns an empty array if the dealer has no active
 * deployments — caller should short-circuit instead of querying the VPS.
 */
async function dealerVehicleNumbers(dealerId: string): Promise<string[]> {
    const rows = await db
        .select({ vehicle_number: deviceBatteryMap.vehicle_number })
        .from(deviceBatteryMap)
        .where(
            and(
                eq(deviceBatteryMap.dealer_id, dealerId),
                eq(deviceBatteryMap.status, "active"),
                isNotNull(deviceBatteryMap.vehicle_number),
            ),
        );
    return rows
        .map((r) => r.vehicle_number)
        .filter((v): v is string => !!v);
}

/**
 * Resolve the vehicle registration numbers matching an optional
 * dealer / state / city filter from the RDS `device_battery_map`. Any subset of
 * the three may be provided; they AND together. Only active deployments with a
 * vehicle_number are returned. Callers treat an empty array as "no match" and
 * short-circuit instead of querying the VPS.
 */
async function vehicleNumbersByLocation(
    state?: string,
    city?: string,
    dealerId?: string,
): Promise<string[]> {
    const conds = [
        eq(deviceBatteryMap.status, "active"),
        isNotNull(deviceBatteryMap.vehicle_number),
    ];
    if (state) conds.push(eq(deviceBatteryMap.state, state));
    if (city) conds.push(eq(deviceBatteryMap.city, city));
    if (dealerId) conds.push(eq(deviceBatteryMap.dealer_id, dealerId));

    const rows = await db
        .select({ vehicle_number: deviceBatteryMap.vehicle_number })
        .from(deviceBatteryMap)
        .where(and(...conds));
    return rows
        .map((r) => r.vehicle_number)
        .filter((v): v is string => !!v);
}
