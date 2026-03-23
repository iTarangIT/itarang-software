import { telemetryDb, sql } from './db';

// ─── Fleet Dashboard Queries ─────────────────────────────────────────────────

export async function fetchFleetDashboardCEO() {
    try {
        const [fleetStats] = await telemetryDb.execute(sql`
            SELECT
                COUNT(DISTINCT dbm.device_id) AS fleet_size,
                ROUND(AVG(br.soh)::numeric, 1) AS avg_soh,
                COUNT(DISTINCT CASE WHEN br.soh < 80 THEN dbm.device_id END) AS warranty_at_risk,
                COUNT(DISTINCT CASE WHEN g.recorded_at > NOW() - INTERVAL '24 hours' THEN dbm.device_id END) AS active_24h
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soh FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id
                ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT recorded_at FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id
                ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            WHERE dbm.status = 'active'
        `);

        const alertCount = await telemetryDb.execute(sql`
            SELECT COUNT(*) AS count FROM battery_alerts
            WHERE acknowledged = false AND created_at > NOW() - INTERVAL '24 hours'
        `);

        // SOH trend (last 30 days)
        const sohTrend = await telemetryDb.execute(sql`
            SELECT
                DATE(recorded_at) AS date,
                ROUND(AVG(soh)::numeric, 1) AS avg_soh
            FROM telemetry.battery_readings
            WHERE recorded_at > NOW() - INTERVAL '30 days' AND soh IS NOT NULL
            GROUP BY DATE(recorded_at)
            ORDER BY date
        `);

        // Dealer performance
        const dealerPerformance = await telemetryDb.execute(sql`
            SELECT
                dbm.dealer_id,
                COUNT(DISTINCT dbm.device_id) AS device_count,
                ROUND(AVG(br.soh)::numeric, 1) AS avg_soh,
                COUNT(DISTINCT CASE WHEN ba.id IS NOT NULL THEN dbm.device_id END) AS alert_count
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soh FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN battery_alerts ba ON ba.device_id = dbm.device_id AND ba.acknowledged = false
            WHERE dbm.status = 'active' AND dbm.dealer_id IS NOT NULL
            GROUP BY dbm.dealer_id
            ORDER BY device_count DESC
            LIMIT 10
        `);

        const fs = fleetStats as Record<string, unknown>;
        const utilization = Number(fs.fleet_size) > 0
            ? Math.round((Number(fs.active_24h) / Number(fs.fleet_size)) * 100)
            : 0;

        return {
            role: 'ceo',
            kpis: {
                fleetSize: Number(fs.fleet_size) || 0,
                utilization,
                avgSOH: Number(fs.avg_soh) || 0,
                warrantyAtRisk: Number(fs.warranty_at_risk) || 0,
                activeAlerts: Number((alertCount[0] as Record<string, unknown>).count) || 0,
            },
            warrantyRisk: {
                trend: sohTrend,
                atRiskDevices: Number(fs.warranty_at_risk) || 0,
            },
            dealerPerformance,
            serviceMetrics: {
                fleetUptime: utilization,
                avgDailyDistance: 0,
                offlineDevices: (Number(fs.fleet_size) || 0) - (Number(fs.active_24h) || 0),
            },
        };
    } catch (err) {
        console.error('[Telemetry] fetchFleetDashboardCEO error:', err);
        return {
            role: 'ceo',
            kpis: { fleetSize: 0, utilization: 0, avgSOH: 0, warrantyAtRisk: 0, activeAlerts: 0 },
            warrantyRisk: { trend: [], atRiskDevices: 0 },
            dealerPerformance: [],
            serviceMetrics: { fleetUptime: 0, avgDailyDistance: 0, offlineDevices: 0 },
        };
    }
}

export async function fetchFleetDashboardDealer(dealerId: string) {
    try {
        const [stats] = await telemetryDb.execute(sql`
            SELECT
                COUNT(DISTINCT dbm.device_id) AS vehicle_count,
                ROUND(AVG(br.soc)::numeric, 1) AS avg_soc,
                COUNT(DISTINCT CASE WHEN br.soh < 80 OR br.bms_alarm_status > 0 THEN dbm.device_id END) AS faulty_devices,
                COUNT(DISTINCT CASE WHEN g.recorded_at > NOW() - INTERVAL '24 hours' THEN dbm.device_id END) AS active_today
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soc, soh, bms_alarm_status FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT recorded_at FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            WHERE dbm.dealer_id = ${dealerId} AND dbm.status = 'active'
        `);

        const s = stats as Record<string, unknown>;
        return {
            role: 'dealer',
            kpis: {
                vehicleCount: Number(s.vehicle_count) || 0,
                avgSOC: Number(s.avg_soc) || 0,
                faultyDevices: Number(s.faulty_devices) || 0,
                activeToday: Number(s.active_today) || 0,
                energy24h: 0,
            },
        };
    } catch (err) {
        console.error('[Telemetry] fetchFleetDashboardDealer error:', err);
        return {
            role: 'dealer',
            kpis: { vehicleCount: 0, avgSOC: 0, faultyDevices: 0, activeToday: 0, energy24h: 0 },
        };
    }
}

// ─── Fleet Map ───────────────────────────────────────────────────────────────

export async function fetchFleetMapData(dealerId?: string) {
    try {
        const dealerFilter = dealerId ? sql`AND dbm.dealer_id = ${dealerId}` : sql``;

        const devices = await telemetryDb.execute(sql`
            SELECT
                dbm.device_id,
                dbm.vehicle_number,
                dbm.customer_name,
                dbm.dealer_id,
                br.soc,
                br.soh,
                br.recorded_at AS battery_updated_at,
                g.latitude,
                g.longitude,
                g.recorded_at AS gps_updated_at,
                CASE
                    WHEN ba.severity = 'critical' THEN 'critical'
                    WHEN ba.severity = 'warning' THEN 'warning'
                    WHEN g.recorded_at < NOW() - INTERVAL '24 hours' THEN 'offline'
                    ELSE 'healthy'
                END AS status
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soc, soh, recorded_at FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT latitude, longitude, recorded_at FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            LEFT JOIN LATERAL (
                SELECT severity FROM battery_alerts
                WHERE device_id = dbm.device_id AND acknowledged = false
                ORDER BY created_at DESC LIMIT 1
            ) ba ON true
            WHERE dbm.status = 'active' ${dealerFilter}
        `);

        return devices;
    } catch (err) {
        console.error('[Telemetry] fetchFleetMapData error:', err);
        return [];
    }
}

// ─── Device Queries ──────────────────────────────────────────────────────────

export async function fetchDevices(limit = 50, offset = 0, dealerId?: string) {
    try {
        const dealerFilter = dealerId ? sql`AND dbm.dealer_id = ${dealerId}` : sql``;

        return await telemetryDb.execute(sql`
            SELECT
                dbm.*,
                br.soc,
                br.soh,
                br.recorded_at AS last_reading_at,
                g.recorded_at AS last_gps_at
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soc, soh, recorded_at FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT recorded_at FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            WHERE dbm.status = 'active' ${dealerFilter}
            ORDER BY dbm.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDevices error:', err);
        return [];
    }
}

export async function fetchDeviceById(deviceId: string) {
    try {
        const [device] = await telemetryDb.execute(sql`
            SELECT
                dbm.*,
                br.soc, br.soh, br.voltage, br.current_val, br.temperature,
                br.recorded_at AS last_reading_at,
                g.latitude, g.longitude, g.speed, g.recorded_at AS last_gps_at
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soc, soh, voltage, current_val, temperature, recorded_at
                FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT latitude, longitude, speed, recorded_at
                FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            WHERE dbm.device_id = ${deviceId}
        `);
        return device || null;
    } catch (err) {
        console.error('[Telemetry] fetchDeviceById error:', err);
        return null;
    }
}

export async function fetchDeviceReadings(deviceId: string, hours = 24) {
    try {
        return await telemetryDb.execute(sql`
            SELECT soc, soh, voltage, current_val, temperature, recorded_at
            FROM telemetry.battery_readings
            WHERE device_id = ${deviceId}
                AND recorded_at > NOW() - INTERVAL '1 hour' * ${hours}
            ORDER BY recorded_at ASC
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDeviceReadings error:', err);
        return [];
    }
}

export async function fetchDeviceGPS(deviceId: string, hours = 24) {
    try {
        return await telemetryDb.execute(sql`
            SELECT latitude, longitude, speed, heading, recorded_at
            FROM telemetry.gps_readings
            WHERE device_id = ${deviceId}
                AND recorded_at > NOW() - INTERVAL '1 hour' * ${hours}
            ORDER BY recorded_at ASC
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDeviceGPS error:', err);
        return [];
    }
}

export async function fetchDeviceTrips(deviceId: string, limit = 20) {
    try {
        return await telemetryDb.execute(sql`
            SELECT *
            FROM telemetry.trips
            WHERE device_id = ${deviceId}
            ORDER BY start_time DESC
            LIMIT ${limit}
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDeviceTrips error:', err);
        return [];
    }
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export async function fetchAlerts(limit = 50, acknowledged?: boolean, dealerId?: string) {
    try {
        const ackFilter = acknowledged !== undefined
            ? sql`AND ba.acknowledged = ${acknowledged}`
            : sql``;
        const dealerFilter = dealerId
            ? sql`AND dbm.dealer_id = ${dealerId}`
            : sql``;

        return await telemetryDb.execute(sql`
            SELECT
                ba.*,
                dbm.vehicle_number,
                dbm.customer_name,
                dbm.dealer_id
            FROM battery_alerts ba
            LEFT JOIN device_battery_map dbm ON dbm.device_id = ba.device_id
            WHERE 1=1 ${ackFilter} ${dealerFilter}
            ORDER BY ba.created_at DESC
            LIMIT ${limit}
        `);
    } catch (err) {
        console.error('[Telemetry] fetchAlerts error:', err);
        return [];
    }
}

export async function acknowledgeAlert(alertId: string, acknowledgedBy: string) {
    return telemetryDb.execute(sql`
        UPDATE battery_alerts
        SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = ${acknowledgedBy}
        WHERE id = ${alertId}
    `);
}

export async function fetchAlertConfig() {
    try {
        return await telemetryDb.execute(sql`
            SELECT * FROM alert_config ORDER BY alert_type
        `);
    } catch (err) {
        console.error('[Telemetry] fetchAlertConfig error:', err);
        return [];
    }
}

export async function updateAlertConfig(alertType: string, threshold: number, severity: string) {
    return telemetryDb.execute(sql`
        UPDATE alert_config
        SET threshold_value = ${threshold}, severity = ${severity}, updated_at = NOW()
        WHERE alert_type = ${alertType}
    `);
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function fetchSOHTrend(days = 30) {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                DATE(recorded_at) AS date,
                ROUND(AVG(soh)::numeric, 1) AS avg_soh,
                ROUND(MIN(soh)::numeric, 1) AS min_soh,
                ROUND(MAX(soh)::numeric, 1) AS max_soh
            FROM telemetry.battery_readings
            WHERE recorded_at > NOW() - INTERVAL '1 day' * ${days} AND soh IS NOT NULL
            GROUP BY DATE(recorded_at)
            ORDER BY date
        `);
    } catch (err) {
        console.error('[Telemetry] fetchSOHTrend error:', err);
        return [];
    }
}

export async function fetchWarrantyRisk() {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                dbm.device_id,
                dbm.vehicle_number,
                dbm.customer_name,
                dbm.dealer_id,
                br.soh,
                br.recorded_at AS last_reading
            FROM device_battery_map dbm
            JOIN LATERAL (
                SELECT soh, recorded_at FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id AND soh IS NOT NULL
                ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            WHERE dbm.status = 'active' AND br.soh < 80
            ORDER BY br.soh ASC
        `);
    } catch (err) {
        console.error('[Telemetry] fetchWarrantyRisk error:', err);
        return [];
    }
}

export async function fetchDealerComparison() {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                dbm.dealer_id,
                COUNT(DISTINCT dbm.device_id) AS devices,
                ROUND(AVG(br.soh)::numeric, 1) AS avg_soh,
                ROUND(AVG(br.soc)::numeric, 1) AS avg_soc,
                COUNT(DISTINCT CASE WHEN ba.id IS NOT NULL THEN dbm.device_id END) AS alerts
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT soh, soc FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN battery_alerts ba ON ba.device_id = dbm.device_id AND ba.acknowledged = false
            WHERE dbm.status = 'active' AND dbm.dealer_id IS NOT NULL
            GROUP BY dbm.dealer_id
            ORDER BY devices DESC
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDealerComparison error:', err);
        return [];
    }
}

export async function fetchSOCTrends(days = 30) {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                DATE(recorded_at) AS date,
                ROUND(AVG(soc)::numeric, 1) AS avg_soc,
                ROUND(MIN(soc)::numeric, 1) AS min_soc,
                ROUND(MAX(soc)::numeric, 1) AS max_soc
            FROM telemetry.battery_readings
            WHERE recorded_at > NOW() - INTERVAL '1 day' * ${days} AND soc IS NOT NULL
            GROUP BY DATE(recorded_at)
            ORDER BY date
        `);
    } catch (err) {
        console.error('[Telemetry] fetchSOCTrends error:', err);
        return [];
    }
}

export async function fetchTripsOverview(limit = 50) {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                t.*,
                dbm.vehicle_number,
                dbm.customer_name
            FROM telemetry.trips t
            LEFT JOIN device_battery_map dbm ON dbm.device_id = t.device_id
            ORDER BY t.start_time DESC
            LIMIT ${limit}
        `);
    } catch (err) {
        console.error('[Telemetry] fetchTripsOverview error:', err);
        return [];
    }
}

// ─── Device Mapping ──────────────────────────────────────────────────────────

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
    return telemetryDb.execute(sql`
        INSERT INTO device_battery_map (id, device_id, battery_serial, vehicle_number, vehicle_type, customer_name, customer_phone, dealer_id, status, created_at, updated_at)
        VALUES (${data.id}, ${data.device_id}, ${data.battery_serial || null}, ${data.vehicle_number || null}, ${data.vehicle_type || null}, ${data.customer_name || null}, ${data.customer_phone || null}, ${data.dealer_id || null}, 'active', NOW(), NOW())
    `);
}

export async function updateDeviceMapping(deviceId: string, data: Record<string, unknown>) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
        if (val !== undefined) {
            sets.push(`${key} = $${values.length + 1}`);
            values.push(val);
        }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');

    return telemetryDb.execute(sql`
        UPDATE device_battery_map
        SET ${sql.raw(sets.join(', '))}
        WHERE device_id = ${deviceId}
    `);
}

// ─── System/Database Monitor ─────────────────────────────────────────────────

export async function fetchDatabaseStats() {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                schemaname AS schema,
                relname AS table_name,
                n_live_tup AS row_count,
                pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS total_size
            FROM pg_stat_user_tables
            WHERE schemaname IN ('public', 'telemetry')
            ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDatabaseStats error:', err);
        return [];
    }
}

// ─── Device Communication Status ─────────────────────────────────────────────

export async function fetchDeviceStatus() {
    try {
        return await telemetryDb.execute(sql`
            SELECT
                dbm.device_id,
                dbm.vehicle_number,
                dbm.status,
                br.recorded_at AS last_can_at,
                g.recorded_at AS last_gps_at,
                CASE
                    WHEN br.recorded_at > NOW() - INTERVAL '1 hour' THEN 'online'
                    WHEN br.recorded_at > NOW() - INTERVAL '24 hours' THEN 'intermittent'
                    ELSE 'offline'
                END AS comm_status
            FROM device_battery_map dbm
            LEFT JOIN LATERAL (
                SELECT recorded_at FROM telemetry.battery_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) br ON true
            LEFT JOIN LATERAL (
                SELECT recorded_at FROM telemetry.gps_readings
                WHERE device_id = dbm.device_id ORDER BY recorded_at DESC LIMIT 1
            ) g ON true
            WHERE dbm.status = 'active'
            ORDER BY comm_status, dbm.device_id
        `);
    } catch (err) {
        console.error('[Telemetry] fetchDeviceStatus error:', err);
        return [];
    }
}
