import { NextResponse } from "next/server";

import { requireMonitorAdmin } from "@/lib/monitor/route-guard";
import { fetchMonitorOverview, type MonitorOverview } from "@/lib/telemetry/monitor-queries";
import { isVpsUnreachable, vpsDegradedReason } from "@/lib/telemetry/vps-status";

export const dynamic = "force-dynamic";

/**
 * Everything /monitor renders, in one request.
 *
 * One endpoint rather than six: the page is a single screen with a single poll
 * interval, so splitting it would only buy partial failure modes nobody asked
 * for. Every underlying table is small (see monitor-queries.ts), so the whole
 * payload is cheap.
 */

/**
 * The shape returned when the IoT VPS cannot be reached.
 *
 * Counts are 0 but every *assessment* is null or neutral — the page is being
 * told "nothing was measured", not "everything is fine". Rendering 0 silent
 * vehicles and 0 open alerts as a clean bill of health on the one request that
 * failed to ask is exactly the failure this shape avoids; the client keys off
 * `degraded` and greys the tiles out.
 */
function unmeasured(now: Date): MonitorOverview {
    return {
        generatedAt: now.toISOString(),
        fleet: {
            fleetSize: 0,
            liveNow: 0,
            livePct: 0,
            reportedLast24h: 0,
            silentOver24h: 0,
            neverReported: 0,
            newestSignalAgeMs: null,
            silence: {
                battery: { under_1h: 0, "1h_24h": 0, "1d_7d": 0, over_7d: 0, never: 0 },
                gps: { under_1h: 0, "1h_24h": 0, "1d_7d": 0, over_7d: 0, never: 0 },
            },
            soc: {
                buckets: { "0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0 },
                below20: 0,
                withReading: 0,
                avg: null,
            },
        },
        attention: [],
        alerts: { open: 0, distinctTypes: 0 },
        distance: {
            totalKm30d: 0,
            vehicles30d: 0,
            vehicleDays30d: 0,
            avgKmPerVehicleDay: null,
            series14d: [],
        },
        mapping: {
            telemetryVehicles: 0,
            mapped: 0,
            unmapped: 0,
            withState: 0,
            withDealer: 0,
            states: 0,
        },
        notMeasurable: {
            soh: { reporting: 0, distinctValues: 0, constantValue: null },
            trips: { hasRows: false, tableMissing: false },
            energy: { rowsWithValue: 0, rowsInWindow: 0 },
            dealerAttribution: { mapped: 0, total: 0 },
        },
    };
}

export async function GET() {
    const auth = await requireMonitorAdmin();
    if (!auth.ok) return auth.response;

    try {
        const data = await fetchMonitorOverview();
        return NextResponse.json({ success: true, data });
    } catch (error) {
        if (isVpsUnreachable(error)) {
            return NextResponse.json({
                success: true,
                degraded: true,
                reason: vpsDegradedReason(error),
                data: unmeasured(new Date()),
            });
        }
        // Log the real error server-side. The message that reaches the browser is
        // the Error's own text, which for a query bug here is a pg error —
        // deliberately surfaced rather than swallowed into "something went wrong",
        // because a masked SQLSTATE is how a broken query gets mistaken for an
        // empty fleet.
        console.error("[Monitor Overview] Error:", error);
        const message = error instanceof Error ? error.message : "Server error";
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
