import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchBatteryGeo } from '@/lib/telemetry/geo-queries';
import { analyticsError, parseBatteryParams } from '../_params';

// Location analytics for one battery: the kilometre heat map, dwell clusters, the parking spot,
// and the overnight (home) location. All from telemetry_gps.
//
// See docs/intellicar-calculations.md §20.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const parsed = parseBatteryParams(req);
        if (!parsed.ok) return parsed.response;

        const { vehicleno, ...opts } = parsed.params;
        const data = await fetchBatteryGeo(vehicleno, opts);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return analyticsError('Battery Geo', error);
    }
}
