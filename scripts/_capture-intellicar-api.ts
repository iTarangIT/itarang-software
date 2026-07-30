/**
 * Capture REAL payloads for every Intellicar dashboard endpoint, for
 * docs/intellicar-api-and-data-storage.md.
 *
 * Calls the query layer directly rather than going over HTTP, so no dev server and no
 * logged-in session are needed — the routes are thin `{success, data}` wrappers around
 * exactly these functions.
 *
 * STRICTLY READ-ONLY. Only `fetch…` / `get…` functions are imported; nothing that writes
 * (createDeviceMapping, acknowledgeAlert, setBatteryThresholds, updateAlertConfig) is
 * reachable from this file.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_capture-intellicar-api.ts
 *
 * RDS-only captures succeed without the IoT tunnel; IoT-backed ones report their
 * connection error instead of aborting the run.
 */
import { writeFileSync } from "node:fs";
import {
    fetchAlertConfig,
    fetchAlerts,
    fetchDatabaseStats,
    fetchDealerComparison,
    fetchDeviceById,
    fetchDeviceGPS,
    fetchDeviceReadings,
    fetchDeviceStatus,
    fetchDeviceTrips,
    fetchDevices,
    fetchFleetDashboardCEO,
    fetchFleetLocations,
    fetchFleetMapData,
    fetchSOCTrends,
    fetchSOHTrend,
    fetchSocTimeline,
    fetchBatteryAhAnalytics,
    fetchVehicleActivity,
    fetchWarrantyRisk,
} from "@/lib/telemetry/queries";
import {
    fetchDeepDischarge,
    fetchDischargeAnalytics,
    fetchDistanceTrend,
    fetchElectricalTrend,
    fetchEnergyTrend,
    fetchTelemetryCadence,
    fetchDischargeVsKm,
} from "@/lib/telemetry/battery-queries";
import { fetchBatteryGeo } from "@/lib/telemetry/geo-queries";
import { getBatteryThresholds } from "@/lib/telemetry/thresholds";
import { db } from "@/lib/db";
import { deviceBatteryMap } from "@/lib/db/schema";
import { isNotNull } from "drizzle-orm";

const OUT = process.argv[2] ?? "intellicar-api-capture.json";

type Capture = { endpoint: string; source: string; ok: boolean; data?: unknown; error?: string };
const results: Capture[] = [];

async function grab(endpoint: string, source: string, fn: () => Promise<unknown>) {
    try {
        const data = await fn();
        results.push({ endpoint, source, ok: true, data });
        const n = Array.isArray(data) ? `${data.length} rows` : "object";
        console.log(`  OK    ${endpoint}  (${n})`);
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        results.push({ endpoint, source, ok: false, error });
        console.log(`  FAIL  ${endpoint}  — ${error.slice(0, 90)}`);
    }
}

async function main() {
    // A real vehicle to drive the per-battery routes. Prefer one the IoT DB knows about;
    // fall back to the RDS mapping so the RDS-only captures still get a concrete input.
    let vehicleno = process.env.CAPTURE_VEHICLENO ?? "";
    if (!vehicleno) {
        try {
            const devices = (await fetchDevices(1, 0)) as Array<{ vehicle_number?: string }>;
            vehicleno = devices[0]?.vehicle_number ?? "";
        } catch {
            const [row] = await db
                .select({ v: deviceBatteryMap.vehicle_number })
                .from(deviceBatteryMap)
                .where(isNotNull(deviceBatteryMap.vehicle_number))
                .limit(1);
            vehicleno = row?.v ?? "";
        }
    }
    console.log(`vehicleno for per-battery routes: ${vehicleno || "(none found)"}\n`);

    const period = { months: 3, month: undefined, from: undefined, to: undefined };

    console.log("RDS-only (no tunnel needed):");
    await grab("GET /api/telemetry/fleet/locations", "RDS", () => fetchFleetLocations());
    await grab("GET /api/telemetry/analytics/thresholds", "RDS", () => getBatteryThresholds());
    await grab(
        `GET /api/telemetry/analytics/thresholds?vehicleno=${vehicleno}`,
        "RDS",
        () => getBatteryThresholds(vehicleno),
    );
    await grab("GET /api/telemetry/alerts/config", "static", () => fetchAlertConfig());

    console.log("\nIoT-backed:");
    await grab("GET /api/telemetry/fleet/dashboard", "IoT+RDS", () => fetchFleetDashboardCEO());
    await grab("GET /api/telemetry/fleet/map", "IoT", () => fetchFleetMapData());
    await grab("GET /api/telemetry/devices?limit=3", "IoT", () => fetchDevices(3, 0));
    await grab("GET /api/telemetry/devices/status", "IoT", () => fetchDeviceStatus());
    await grab("GET /api/telemetry/alerts?limit=5", "IoT+RDS", () => fetchAlerts(5, undefined));
    await grab("GET /api/telemetry/health/degradation?days=30", "IoT", () => fetchSOHTrend(30));
    await grab("GET /api/telemetry/analytics/warranty", "IoT+RDS", () => fetchWarrantyRisk());
    await grab("GET /api/telemetry/analytics/dealer-comparison", "IoT+RDS", () => fetchDealerComparison());
    await grab("GET /api/telemetry/trips/overview?limit=5", "IoT+RDS", () => fetchVehicleActivity(5));
    await grab("GET /api/system/database-monitor", "IoT", () => fetchDatabaseStats());
    await grab("GET /api/telemetry/analytics/soc-trends?days=30", "IoT", () => fetchSOCTrends(30));

    if (vehicleno) {
        console.log("\nPer-battery (IoT):");
        await grab("GET /api/telemetry/analytics/cadence", "IoT", () => fetchTelemetryCadence(vehicleno, period));
        await grab("GET /api/telemetry/analytics/ah-trend", "IoT", () => fetchBatteryAhAnalytics(vehicleno, period));
        await grab("GET /api/telemetry/analytics/soc-timeline", "IoT", () => fetchSocTimeline(vehicleno, period));
        await grab("GET /api/telemetry/analytics/discharge-cycles", "IoT", () => fetchDischargeAnalytics(vehicleno, period));
        await grab("GET /api/telemetry/analytics/deep-discharge", "IoT", () => fetchDeepDischarge(vehicleno, period));
        await grab("GET /api/telemetry/analytics/energy-trend", "IoT", () => fetchEnergyTrend(vehicleno, period, "month"));
        await grab("GET /api/telemetry/analytics/distance-trend", "IoT", () => fetchDistanceTrend(vehicleno, period, "day"));
        await grab("GET /api/telemetry/analytics/discharge-vs-km", "IoT", () => fetchDischargeVsKm(vehicleno, period));
        await grab("GET /api/telemetry/analytics/electrical-trend", "IoT", () => fetchElectricalTrend(vehicleno, period, "day"));
        await grab("GET /api/telemetry/analytics/geo", "IoT", () => fetchBatteryGeo(vehicleno, period));

        console.log("\nUncalled routes (IoT):");
        await grab(`GET /api/telemetry/devices/${vehicleno}`, "IoT", () => fetchDeviceById(vehicleno));
        await grab(`GET /api/telemetry/devices/${vehicleno}/readings?hours=24`, "IoT", () => fetchDeviceReadings(vehicleno, 24));
        await grab(`GET /api/telemetry/devices/${vehicleno}/gps?hours=24`, "IoT", () => fetchDeviceGPS(vehicleno, 24));
        await grab(`GET /api/telemetry/devices/${vehicleno}/trips?limit=5`, "IoT", () => fetchDeviceTrips(vehicleno, 5));
    }

    writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), vehicleno, results }, null, 2));
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n${ok}/${results.length} captured → ${OUT}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error("FAILED:", e);
        process.exit(1);
    });
