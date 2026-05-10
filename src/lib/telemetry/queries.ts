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

export async function fetchFleetDashboardCEO() {
    const iot = getIotSql();

    const [stats] = await iot`
        SELECT
            count(*)::int                                                       AS fleet_size,
            count(*) FILTER (WHERE online)::int                                 AS active_now,
            round(avg(soh_pct)::numeric, 1)::float                              AS avg_soh,
            count(*) FILTER (WHERE soh_pct IS NOT NULL AND soh_pct < 80)::int   AS warranty_at_risk
        FROM vehicle_state
    `;

    const [alertCount] = await iot`
        SELECT count(*)::int AS active_alerts
        FROM alerts
        WHERE resolved_at IS NULL
    `;

    const sohTrend = await iot`
        SELECT
            date_trunc('day', time)::date          AS date,
            round(avg(soh_pct)::numeric, 1)::float AS avg_soh
        FROM telemetry_battery
        WHERE time > now() - interval '30 days' AND soh_pct IS NOT NULL
        GROUP BY 1
        ORDER BY 1
    `;

    const [distance] = await iot`
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
        dealerPerformance: await fetchDealerPerformanceInner(),
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

// ─── Fleet Map / Devices ─────────────────────────────────────────────────────

export async function fetchFleetMapData(dealerId?: string) {
    const iot = getIotSql();

    if (dealerId) {
        const vehicleNos = await dealerVehicleNumbers(dealerId);
        if (vehicleNos.length === 0) return [];
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
                    ELSE 'healthy'
                END            AS status
            FROM vehicle_state vs
            LEFT JOIN vehicles v USING (vehicleno)
            WHERE vs.vehicleno = ANY(${vehicleNos})
            ORDER BY vs.last_seen DESC NULLS LAST
        `;
    }

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
                ELSE 'healthy'
            END            AS status
        FROM vehicle_state vs
        LEFT JOIN vehicles v USING (vehicleno)
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

async function fetchDealerPerformanceInner() {
    const mappings = await db
        .select({
            dealer_id: deviceBatteryMap.dealer_id,
            vehicle_number: deviceBatteryMap.vehicle_number,
        })
        .from(deviceBatteryMap)
        .where(
            and(
                eq(deviceBatteryMap.status, "active"),
                isNotNull(deviceBatteryMap.dealer_id),
                isNotNull(deviceBatteryMap.vehicle_number),
            ),
        );

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
