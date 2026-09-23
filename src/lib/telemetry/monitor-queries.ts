/**
 * The single query behind the Fleet Monitor page (/monitor).
 *
 * DELIBERATELY TOUCHES ONLY SMALL TABLES. Everything here reads `vehicle_state`
 * (~331 rows), `alerts`, `distance_rollup` (~25k rows) and the CRM's
 * `device_battery_map` (~285 rows). It never scans telemetry_can /
 * telemetry_battery / telemetry_gps, which matters because pg_partman has been
 * stalled since 2026-07-04 and ~15.8GB of the 16GB IoT database now sits in
 * DEFAULT partitions that no time filter can prune. A page that polls every
 * minute cannot afford to read those.
 *
 * Cross-DB joins happen in this process — the IoT VPS and the CRM RDS are not
 * federated, the same way src/lib/telemetry/queries.ts does it.
 *
 * The "not measurable" facts are MEASURED, not hardcoded. If someone deploys
 * the aggregator or backfills dealer_id, the page stops claiming those signals
 * are dead without anyone editing this file.
 */
import { getIotSql } from "@/lib/db/iot";
import { db } from "@/lib/db";
import { deviceBatteryMap } from "@/lib/db/schema";
import {
    summariseVehicleStates,
    type AttentionRow,
    type MonitorSummary,
    type VehicleStateRow,
} from "@/lib/telemetry/monitor-math";

const ATTENTION_LIMIT = 15;

export type AttentionRowEnriched = AttentionRow & {
    state: string | null;
    city: string | null;
};

export type DistanceDay = { day: string; vehicles: number; km: number };

export type MonitorOverview = {
    generatedAt: string;
    fleet: Omit<MonitorSummary, "attention">;
    attention: AttentionRowEnriched[];
    alerts: {
        /** Every row in `alerts` is alert_type='offline'. The UI must say "connectivity". */
        open: number;
        distinctTypes: number;
    };
    distance: {
        totalKm30d: number;
        vehicles30d: number;
        vehicleDays30d: number;
        avgKmPerVehicleDay: number | null;
        series14d: DistanceDay[];
    };
    mapping: {
        telemetryVehicles: number;
        mapped: number;
        unmapped: number;
        withState: number;
        withDealer: number;
        states: number;
    };
    /** Signals that exist in the schema but carry no information. Each is measured. */
    notMeasurable: {
        soh: { reporting: number; distinctValues: number; constantValue: number | null };
        trips: { hasRows: boolean; tableMissing: boolean };
        energy: { rowsWithValue: number; rowsInWindow: number };
        dealerAttribution: { mapped: number; total: number };
    };
};

/** Postgres "relation does not exist" — a table the aggregator was to create. */
function isMissingTable(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "42P01";
}

export async function fetchMonitorOverview(now: Date = new Date()): Promise<MonitorOverview> {
    const iot = getIotSql();

    // vehicle_state is one row per vehicle — small enough to pull whole and
    // aggregate in Node, which keeps every band/threshold decision in the
    // unit-tested monitor-math module instead of spread across SQL.
    const stateRows = (await iot`
        SELECT vehicleno,
               online,
               soc_pct::float       AS soc_pct,
               soh_pct::float       AS soh_pct,
               last_battery_at,
               last_gps_at,
               open_alert_count
        FROM vehicle_state
    `) as Array<VehicleStateRow & { soh_pct: number | null }>;

    const [alertRow] = await iot`
        SELECT count(*)::int                        AS open,
               count(DISTINCT alert_type)::int      AS distinct_types
        FROM alerts
        WHERE resolved_at IS NULL
    `;

    // bucket_size='day' is pinned on both reads: distance_rollup holds several
    // bucket sizes and mixing them silently dilutes every per-day figure.
    const [dist30] = await iot`
        SELECT coalesce(sum(distance_km), 0)::float  AS total_km,
               count(DISTINCT vehicleno)::int        AS vehicles,
               count(*)::int                         AS vehicle_days,
               count(energy_kwh)::int                AS energy_rows
        FROM distance_rollup
        WHERE bucket_size = 'day'
          AND time >= now() - interval '30 days'
    `;

    const series14d = (await iot`
        SELECT to_char(date_trunc('day', time), 'YYYY-MM-DD')  AS day,
               count(DISTINCT vehicleno)::int                  AS vehicles,
               round(sum(distance_km)::numeric, 1)::float      AS km
        FROM distance_rollup
        WHERE bucket_size = 'day'
          AND time >= now() - interval '14 days'
        GROUP BY 1
        ORDER BY 1
    `) as unknown as DistanceDay[];

    // `trips` is expected to be empty (the segmentation job was never deployed
    // after the AWS migration) and may not exist at all on some boxes. Both are
    // reported rather than thrown.
    let tripsHasRows = false;
    let tripsTableMissing = false;
    try {
        const [t] = await iot`SELECT EXISTS (SELECT 1 FROM trips LIMIT 1) AS has_rows`;
        tripsHasRows = Boolean(t?.has_rows);
    } catch (error) {
        if (!isMissingTable(error)) throw error;
        tripsTableMissing = true;
    }

    const mapRows = await db
        .select({
            vehicle_number: deviceBatteryMap.vehicle_number,
            state: deviceBatteryMap.state,
            city: deviceBatteryMap.city,
            dealer_id: deviceBatteryMap.dealer_id,
        })
        .from(deviceBatteryMap);

    const byVehicle = new Map<string, (typeof mapRows)[number]>();
    for (const r of mapRows) {
        const key = r.vehicle_number?.trim();
        if (key) byVehicle.set(key, r);
    }

    const summary = summariseVehicleStates(stateRows, now, { attentionLimit: ATTENTION_LIMIT });
    const { attention, ...fleet } = summary;

    const attentionEnriched: AttentionRowEnriched[] = attention.map((row) => {
        const m = byVehicle.get(row.vehicleno.trim());
        return { ...row, state: m?.state ?? null, city: m?.city ?? null };
    });

    const telemetryVehicles = stateRows.length;
    let mapped = 0;
    for (const row of stateRows) {
        if (byVehicle.has(row.vehicleno.trim())) mapped += 1;
    }

    const states = new Set<string>();
    let withState = 0;
    let withDealer = 0;
    for (const r of mapRows) {
        const s = r.state?.trim();
        if (s) {
            states.add(s);
            withState += 1;
        }
        if (r.dealer_id?.trim()) withDealer += 1;
    }

    // SOH is measured live rather than asserted: if every reporting pack returns
    // the same number, the sensor is not measuring anything. Reading it off
    // vehicle_state costs nothing extra — the column is already in the select
    // above — and it means the page's claim tracks reality.
    const sohValues = stateRows
        .map((r) => r.soh_pct)
        .filter((v): v is number => v !== null && Number.isFinite(v));
    const distinctSoh = new Set(sohValues);

    const vehicleDays = Number(dist30?.vehicle_days) || 0;
    const totalKm = Number(dist30?.total_km) || 0;

    return {
        generatedAt: now.toISOString(),
        fleet,
        attention: attentionEnriched,
        alerts: {
            open: Number(alertRow?.open) || 0,
            distinctTypes: Number(alertRow?.distinct_types) || 0,
        },
        distance: {
            totalKm30d: Math.round(totalKm * 10) / 10,
            vehicles30d: Number(dist30?.vehicles) || 0,
            vehicleDays30d: vehicleDays,
            // Per vehicle-day actually recorded, not per calendar day — a vehicle
            // that reported on 3 of 30 days must not have its average divided by 30.
            avgKmPerVehicleDay:
                vehicleDays === 0 ? null : Math.round((totalKm / vehicleDays) * 10) / 10,
            series14d: series14d.map((d) => ({
                day: d.day,
                vehicles: Number(d.vehicles) || 0,
                km: Number(d.km) || 0,
            })),
        },
        mapping: {
            telemetryVehicles,
            mapped,
            unmapped: telemetryVehicles - mapped,
            withState,
            withDealer,
            states: states.size,
        },
        notMeasurable: {
            soh: {
                reporting: sohValues.length,
                distinctValues: distinctSoh.size,
                constantValue: distinctSoh.size === 1 ? sohValues[0] : null,
            },
            trips: { hasRows: tripsHasRows, tableMissing: tripsTableMissing },
            energy: {
                rowsWithValue: Number(dist30?.energy_rows) || 0,
                rowsInWindow: vehicleDays,
            },
            dealerAttribution: { mapped: withDealer, total: mapRows.length },
        },
    };
}
