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
import {
    avgSamplingIntervalS,
    capacityConfidence,
    capacityGates,
    capacityPlausible,
    extrapolateCapacity,
    type Confidence,
} from "@/lib/telemetry/charging-math";
import {
    buildTimeWindow,
    countSamplesQuery,
    cycleCTEs,
    type ChargingWindowOpts,
} from "@/lib/telemetry/charging-sql";

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
 *   1. Dedupe by timestamp, then order by time; compute Δsoc and Δt against the
 *      previous distinct sample. See cycleCTEs for why the dedupe is load-bearing.
 *   2. A charging session = a contiguous run where SOC is non-decreasing
 *      (Δsoc ≥ 0) and the gap is ≤ SESSION_GAP_MAX_S. Any SOC drop (discharge/
 *      drive) or a longer gap ends the session. The session is then trimmed to the
 *      first and last samples carrying current, so idle time at either end is not
 *      counted as charging.
 *   3. AH is the trapezoidal integral of |pack_current| over the cycle's *actual*
 *      elapsed time — every interval inside the cycle, not only the rising steps.
 *      |·| guards the unsigned pack-current convention.
 *   4. Keep cycles with net SOC gain ≥ MIN_CYCLE_SOC_GAIN and AH > 0.
 *   5. Extrapolate full (100%) capacity: ah_charged ÷ (Δsoc/100), gated on a large
 *      enough swing and on the cycle's time coverage.
 */
/**
 * The complete record of one validated charging cycle.
 *
 * Every field the charging-cycle spec requires is here, and none of them is ever withheld:
 * detection decides whether a charge happened, `capacity_confidence` decides how far to trust
 * the numbers that describe it. A cycle we rejected and a cycle we do not trust are different
 * facts, and this type keeps them different.
 */
export interface ChargingCycleAggregate {
    /** 1-based, chronological — the "Charging Cycle Number". */
    cycle_no: number;
    /** Groups this cycle's samples in fetchChargingCycleDetail. */
    break_id: number;
    start_time: Date;
    end_time: Date;
    duration_s: number;
    ah_charged: number;
    start_soc: number | null;
    end_soc: number | null;
    /** end_soc − start_soc: the swing the capacity extrapolation divides by. */
    soc_difference: number | null;
    /** Mean current over the samples that were actually carrying current. */
    avg_charging_current: number | null;
    /** Peak charging current. */
    max_charging_current: number | null;
    /**
     * Percentage of the cycle's elapsed time covered by intervals short enough to trust
     * (≤ COVERAGE_TRUST_GAP_S). Low coverage means the Ah total leans on interpolation across
     * long gaps — which lowers the confidence grade rather than deleting the estimate.
     */
    coverage_pct: number | null;
    /** Total CAN samples the coulomb count integrated over. */
    n_samples: number;
    /** Of those, how many actually carried a current reading. */
    n_current_samples: number;
    /** Mean seconds between stored samples — duration ÷ (n_samples − 1). */
    avg_sampling_interval_s: number | null;
    /** The widest silence inside the charge. */
    max_gap_s: number | null;
    /** BMS nameplate, for the plausibility check. */
    rated_capacity_ah: number | null;
    /** Estimated for EVERY cycle whose SOC rose. Null only when ΔSOC ≤ 0. */
    estimated_capacity_ah: number | null;
    /** How far the estimate can be trusted. Carry it wherever you carry the number. */
    capacity_confidence: Confidence;
    /** False when the estimate is physically incredible against the nameplate. */
    capacity_plausible: boolean;
    /** Gained less than MIN_CYCLE_SOC_GAIN — a real charge, just a small one. */
    is_topup: boolean;
    /** Had enough samples for the integral to mean anything. */
    enough_samples: boolean;
}

/**
 * Per-cycle aggregates — the authoritative numbers. Anything that needs a cycle's
 * AH / duration / SOC / capacity must read them from here rather than re-summing
 * the raw samples: Postgres `round(numeric, 2)` is half-away-from-zero while JS
 * `Math.round` is half-up, `end_time` is the last *rising* sample (not the last
 * row), and `duration_s` deliberately excludes the first attributed interval.
 */
export async function fetchChargingCycleAggregate(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<{
    vehicleno: string;
    months: number | null;
    month: string | null;
    from: string | null;
    to: string | null;
    cycles: ChargingCycleAggregate[];
}> {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    const cte = cycleCTEs(iot, vehicleno, timePredicate);

    const rows = (await iot`
        ${cte}
        SELECT
            break_id,
            start_time,
            end_time,
            duration_s,
            round(ah_charged::numeric, 2)::float            AS ah_charged,
            start_soc::float                                AS start_soc,
            end_soc::float                                  AS end_soc,
            round((end_soc - start_soc)::numeric, 1)::float AS soc_difference,
            round(avg_charging_current::numeric, 1)::float   AS avg_charging_current,
            round(max_charging_current::numeric, 1)::float   AS max_charging_current,
            coverage_pct,
            n_samples,
            n_current_samples,
            enough_samples,
            is_topup,
            max_gap_s,
            rated_capacity_ah
        FROM cycle_valid
        WHERE is_valid
        ORDER BY start_time ASC
    `) as Array<{
        break_id: number;
        start_time: Date;
        end_time: Date;
        duration_s: number | null;
        ah_charged: number | null;
        start_soc: number | null;
        end_soc: number | null;
        soc_difference: number | null;
        avg_charging_current: number | null;
        max_charging_current: number | null;
        coverage_pct: number | null;
        n_samples: number;
        n_current_samples: number;
        enough_samples: boolean;
        is_topup: boolean;
        max_gap_s: number | null;
        rated_capacity_ah: number | null;
    }>;

    const num = (v: number | null | undefined) => (v != null ? Number(v) : null);

    const cycles = rows.map((r, i) => {
        const ah = Number(r.ah_charged) || 0;
        const socDifference = num(r.soc_difference);
        const coveragePct = num(r.coverage_pct);
        const ratedAh = num(r.rated_capacity_ah);
        const nSamples = Number(r.n_samples) || 0;
        const durationS = Number(r.duration_s) || 0;

        // Capacity is now estimated for EVERY cycle whose SOC rose — never withheld. What
        // travels with it is a grade: `high` means the swing, the coverage and the sample count
        // all support the number; `low` means it is arithmetically valid and epistemically
        // worthless. Withholding it told the reader nothing; the number plus its grade tells
        // them everything. See docs/intellicar-calculations.md §5.
        const estimate = extrapolateCapacity(ah, socDifference);
        const confidence = capacityConfidence(socDifference, coveragePct, nSamples);

        return {
            /** 1-based, in chronological order — the "Charging Cycle Number". */
            cycle_no: i + 1,
            break_id: Number(r.break_id),
            start_time: r.start_time,
            end_time: r.end_time,
            duration_s: durationS,
            ah_charged: Math.round(ah * 100) / 100,
            start_soc: num(r.start_soc),
            end_soc: num(r.end_soc),
            soc_difference: socDifference,
            avg_charging_current: num(r.avg_charging_current),
            max_charging_current: num(r.max_charging_current),
            coverage_pct: coveragePct,
            n_samples: nSamples,
            n_current_samples: Number(r.n_current_samples) || 0,
            /** Mean seconds between stored samples — n−1 intervals, not n. */
            avg_sampling_interval_s: avgSamplingIntervalS(durationS, nSamples),
            /** Widest silence inside the charge. */
            max_gap_s: num(r.max_gap_s),
            rated_capacity_ah: ratedAh,
            estimated_capacity_ah: estimate,
            capacity_confidence: confidence,
            capacity_plausible: capacityPlausible(estimate, ratedAh),
            /** Gained less than MIN_CYCLE_SOC_GAIN — a top-up, still a real charge. */
            is_topup: r.is_topup === true,
            enough_samples: r.enough_samples === true,
        };
    });

    return { vehicleno, months, month, from, to, cycles };
}

export async function fetchBatteryAhAnalytics(
    vehicleno: string,
    opts: ChargingWindowOpts,
) {
    const { months, month, from, to, cycles: aggregates } =
        await fetchChargingCycleAggregate(vehicleno, opts);

    // Shape for the Battery Analytics UI: break_id is an export-only concern and stays out of
    // this payload. Everything else the spec requires per cycle travels through.
    const sessions = aggregates.map((r) => ({
        cycle_no: r.cycle_no,
        start_time: r.start_time,
        end_time: r.end_time,
        duration_s: r.duration_s,
        ah_charged: r.ah_charged,
        start_soc: r.start_soc,
        end_soc: r.end_soc,
        soc_difference: r.soc_difference,
        avg_charging_current: r.avg_charging_current,
        max_charging_current: r.max_charging_current,
        coverage_pct: r.coverage_pct,
        n_samples: r.n_samples,
        n_current_samples: r.n_current_samples,
        avg_sampling_interval_s: r.avg_sampling_interval_s,
        max_gap_s: r.max_gap_s,
        rated_capacity_ah: r.rated_capacity_ah,
        estimated_capacity_ah: r.estimated_capacity_ah,
        capacity_confidence: r.capacity_confidence,
        capacity_plausible: r.capacity_plausible,
        is_topup: r.is_topup,
        enough_samples: r.enough_samples,
    }));

    const cycles = sessions.length;
    const totalAh = sessions.reduce((s, r) => s + r.ah_charged, 0);

    // The headline "Avg Capacity" averages only the HIGH-confidence estimates.
    //
    // Every cycle now carries an estimate, including the ones extrapolated from a 2% swing where
    // the error is amplified ×50. Averaging those in would drag the fleet's headline capacity
    // number toward noise — the estimate is reported per cycle so it can be inspected, not so it
    // can be averaged. The count of what was excluded is returned alongside, so the smaller
    // denominator is never a mystery.
    const caps = sessions
        .filter((r) => r.capacity_confidence === "high")
        .map((r) => r.estimated_capacity_ah)
        .filter((v): v is number => v != null);
    const socGains = sessions
        .map((r) => r.soc_difference)
        .filter((v): v is number => v != null);
    const avg = (arr: number[]) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        sessions,
        summary: {
            chargingCycles: cycles,
            totalAhCharged: Math.round(totalAh * 10) / 10,
            avgAhPerSession: Math.round(avg(sessions.map((r) => r.ah_charged)) * 10) / 10,
            /** Averaged over HIGH-confidence estimates only — see the note above `caps`. */
            avgCapacityAh: caps.length ? Math.round(avg(caps) * 10) / 10 : null,
            avgSessionDurationMin:
                Math.round(avg(sessions.map((r) => r.duration_s)) / 60 * 10) / 10,
            avgSocGained: Math.round(avg(socGains) * 10) / 10,
            /** Mean seconds between stored samples across every cycle. */
            avgSamplingIntervalS: (() => {
                const xs = sessions
                    .map((r) => r.avg_sampling_interval_s)
                    .filter((v): v is number => v != null);
                return xs.length ? Math.round(avg(xs) * 10) / 10 : null;
            })(),
            /** How many cycles' capacity estimates can actually be trusted. */
            capacityConfidence: {
                high: sessions.filter((s) => s.capacity_confidence === "high").length,
                medium: sessions.filter((s) => s.capacity_confidence === "medium").length,
                low: sessions.filter((s) => s.capacity_confidence === "low").length,
            },
            /** Real charges that gained less than MIN_CYCLE_SOC_GAIN — counted, not discarded. */
            topUpCycles: sessions.filter((s) => s.is_topup).length,
            /** Nameplate, so the UI can show the estimate against what it should be. */
            ratedCapacityAh:
                sessions.find((s) => s.rated_capacity_ah != null)?.rated_capacity_ah ??
                null,
            /** Cycles whose estimate contradicts the nameplate — a measurement fault. */
            implausibleCycles: sessions.filter(
                (s) => s.estimated_capacity_ah != null && !s.capacity_plausible,
            ).length,
            /** The thresholds in force, so the UI can say what it graded and why. */
            gates: capacityGates(),
        },
    };
}

export interface ChargingSample {
    time: Date;
    soc_pct: number | null;
    pack_current: number | null;
    pack_voltage: number | null;
    /** SOC change over the interval *ending* at this sample. */
    dsoc: number | null;
    /** Seconds since the previous sample — the interval *ending* at this sample. */
    dt_s: number | null;
    /** Pack current at the previous sample — the other end of the AH trapezoid. */
    prev_current: number | null;
    /** 1 when this sample's interval qualifies as charging (dsoc >= 0, gap within bounds). */
    in_sess: number;
    break_id: number;
    /** True when this sample lies within its session's trimmed charging boundaries. */
    in_cycle: boolean;
    /** True when in_cycle AND this sample's cycle survived the SOC-swing / AH > 0 filter. */
    in_valid_cycle: boolean;
}

/**
 * Every telemetry sample in the window, tagged with the cycle it belongs to.
 *
 * Display-only. These rows let an engineer see the raw telemetry behind each
 * cycle, but the cycle's headline numbers must come from
 * fetchChargingCycleAggregate — see the note there on why re-summing drifts.
 *
 * Note on the first row of a cycle: `dsoc`/`dt_s` describe the interval *ending*
 * at each sample, so a cycle's first sample carries the gap from the preceding
 * (non-charging) sample. That interval's energy IS counted in `ah_charged`, and
 * `start_time` is this first *rising* sample — not the interval's start.
 */
export async function fetchChargingCycleDetail(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<{
    vehicleno: string;
    months: number | null;
    month: string | null;
    from: string | null;
    to: string | null;
    samples: ChargingSample[];
}> {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    const cte = cycleCTEs(iot, vehicleno, timePredicate);

    const samples = (await iot`
        ${cte}
        SELECT
            g.time,
            g.soc_pct,
            g.pack_current,
            g.pack_voltage,
            g.dsoc,
            g.dt_s::float        AS dt_s,
            g.prev_current::float AS prev_current,
            g.in_sess,
            g.break_id::int      AS break_id,
            g.in_cycle,
            -- FALSE AND NULL = FALSE, so rows outside any cycle (no cycle_valid
            -- match) correctly resolve to false rather than null.
            (g.in_cycle AND cv.is_valid) AS in_valid_cycle
        FROM cycled g
        LEFT JOIN cycle_valid cv ON cv.break_id = g.break_id
        ORDER BY g.time ASC
    `) as unknown as ChargingSample[];

    return { vehicleno, months, month, from, to, samples };
}

/** Enough points to read the shape of a 6-month window without shipping 20k rows. */
export const MAX_TIMELINE_POINTS = 4000;

export interface SocTimelinePoint {
    time: Date;
    soc_pct: number | null;
    /** True when this sample sits inside a detected charging cycle. */
    in_cycle: boolean;
}

/**
 * SOC against time, tagged with cycle membership — the validation chart.
 *
 * Its whole job is to make charging-cycle *detection* falsifiable by eye: the
 * charge → discharge → charge alternation should be obvious, and every rising
 * limb should be shaded as charging. A cycle boundary drawn in the wrong place
 * shows up here immediately, where no aggregate number would reveal it.
 *
 * Evenly strided down to MAX_TIMELINE_POINTS. Striding (rather than time-bucket
 * averaging) is deliberate: averaging would smooth away exactly the sharp SOC
 * transitions this chart exists to expose.
 */
export async function fetchSocTimeline(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<{
    vehicleno: string;
    months: number | null;
    month: string | null;
    from: string | null;
    to: string | null;
    points: SocTimelinePoint[];
}> {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    const cte = cycleCTEs(iot, vehicleno, timePredicate);

    const points = (await iot`
        ${cte}, numbered AS (
            SELECT
                c.time,
                c.soc_pct,
                -- Shade what the dashboard actually COUNTS. This used to read in_cycle
                -- straight off the cycled CTE, which is pre-is_valid, so the chart shaded
                -- runs the cards had thrown away — and the chart whose whole job is to make
                -- cycle detection falsifiable was disagreeing with the number beside it.
                (c.in_cycle AND COALESCE(cv.is_valid, false)) AS in_cycle,
                row_number() OVER (ORDER BY c.time) AS rn,
                count(*) OVER ()                    AS total
            FROM cycled c
            LEFT JOIN cycle_valid cv USING (break_id)
        )
        SELECT time, soc_pct, in_cycle
        FROM numbered
        -- Never stride an in-cycle sample away: a short charge can hold as few as two
        -- stored samples, and dropping either would erase a real cycle from the chart
        -- while it still counts on the cards. In-cycle rows are a small minority of a
        -- 6-month window, so the point budget survives keeping all of them.
        WHERE rn % GREATEST(1, (total / ${MAX_TIMELINE_POINTS})::int) = 0
           OR in_cycle
        ORDER BY time ASC
    `) as unknown as SocTimelinePoint[];

    return { vehicleno, months, month, from, to, points };
}

/**
 * Pre-flight row count for the export cap, so an oversized range is rejected
 * before any rows cross the wire. Mirrors the `raw` CTE's filter exactly.
 */
export async function countChargingSamples(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<number> {
    const iot = getIotSql();
    const { timePredicate } = buildTimeWindow(iot, opts);
    const [row] = (await countSamplesQuery(
        iot,
        vehicleno,
        timePredicate,
    )) as unknown as Array<{ n: number }>;
    return Number(row?.n ?? 0);
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

/**
 * Fleet activity — per vehicle, per day, from `distance_rollup`.
 *
 * ## Why this does not read the `trips` table
 *
 * **`trips` is empty. Zero rows, across the whole fleet.** The per-trip segmentation job in
 * `iot_stack` has never run, so every query against it returns nothing — which is why this
 * panel showed "No trips found" while the same vehicles were demonstrably driving 873,715 km.
 *
 * A panel that renders an empty table over a live fleet is worse than a broken one: it reports
 * "no activity" as a fact. `distance_rollup` (daily buckets, 297 vehicles) is populated and
 * says exactly what the vehicles did, so that is what we show.
 *
 * The cost is honest and stated in the UI: a **day** is the finest grain available. Start/end
 * points, trip duration and average speed live only in `trips`, and they are simply not
 * computed. Restoring them is an `iot_stack` job, not a query fix.
 *
 * `tripsTableRows` is returned so the UI can explain itself rather than silently substituting
 * one thing for another — and so the day the aggregator starts running, it stops explaining.
 */
export async function fetchVehicleActivity(limit = 100) {
    const iot = getIotSql();

    const [rows, tripCount, totals] = await Promise.all([
        iot`
            SELECT
                d.vehicleno                              AS vehicle_number,
                v.owner                                  AS customer_name,
                d.time                                   AS day,
                round(d.distance_km::numeric, 1)::float  AS distance_km
            FROM distance_rollup d
            LEFT JOIN vehicles v USING (vehicleno)
            WHERE d.bucket_size = 'day'
              AND d.distance_km > 0
            ORDER BY d.time DESC, d.distance_km DESC
            LIMIT ${limit}
        `,
        iot`SELECT count(*)::int AS n FROM trips`,
        iot`
            SELECT
                count(DISTINCT vehicleno)::int              AS vehicles,
                round(sum(distance_km)::numeric)::int       AS total_km,
                round(avg(distance_km)::numeric, 1)::float  AS avg_km_per_day
            FROM distance_rollup
            WHERE bucket_size = 'day'
              AND distance_km > 0
              AND time > now() - interval '30 days'
        `,
    ]);

    const t = (totals as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const activity = rows as unknown as Array<Record<string, unknown>>;

    // The IoT-side `vehicles.owner` is blank across this fleet, so the customer name comes from
    // the CRM's device_battery_map over the usual VPS↔RDS bridge — the two databases are not
    // federated, so the join happens here. Only the vehicles on this page are looked up.
    const vehicleNos = Array.from(
        new Set(activity.map((r) => String(r.vehicle_number)).filter(Boolean)),
    );
    const byVehicle = new Map<string, string>();
    if (vehicleNos.length > 0) {
        const mappings = await db
            .select({
                vehicle_number: deviceBatteryMap.vehicle_number,
                customer_name: deviceBatteryMap.customer_name,
            })
            .from(deviceBatteryMap)
            .where(inArray(deviceBatteryMap.vehicle_number, vehicleNos));
        for (const m of mappings) {
            if (m.vehicle_number && m.customer_name) {
                byVehicle.set(m.vehicle_number, m.customer_name);
            }
        }
    }

    return {
        rows: activity.map((r) => ({
            ...r,
            customer_name:
                byVehicle.get(String(r.vehicle_number)) ?? r.customer_name ?? null,
        })),
        /** 0 means the per-trip aggregator still has not run. */
        tripsTableRows: Number(
            (tripCount as unknown as Array<{ n: number }>)[0]?.n ?? 0,
        ),
        summary: {
            vehicles: Number(t.vehicles) || 0,
            totalKm: Number(t.total_km) || 0,
            avgKmPerDay: Number(t.avg_km_per_day) || 0,
        },
    };
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
