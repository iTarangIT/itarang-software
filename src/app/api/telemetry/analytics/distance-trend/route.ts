import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDistanceTrend } from '@/lib/telemetry/battery-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Kilometres per bucket and the running total, from distance_rollup — the only populated
// distance source. Buckets carry has_telemetry so the UI can tell a parked vehicle (0 km)
// from a dead tracker (a gap). See docs/intellicar-calculations.md §15.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, granularity, ...opts } = parsed.params;
        const data = await fetchDistanceTrend(vehicleno, opts, granularity);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Distance Trend', error);
    }
}
