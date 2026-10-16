import { NextRequest, NextResponse } from 'next/server';
import { fetchDeviceReadings } from '@/lib/telemetry/queries';
import { requireVehicleFeedAccess, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';
import { DEFAULT_FEED_HOURS, feedHours } from '@/lib/telemetry/vehicleAccessRules';

// ID 181: a dealer opens only vehicles mapped to it (else 'not found'), at most
// 7 days of readings; every open is written to telemetry_location_access_log.
export async function GET(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        const { deviceId } = await params;
        const raw = new URL(req.url).searchParams.get('hours');
        const gate = await requireVehicleFeedAccess({ deviceId, feed: 'readings', hours: (v) => feedHours(raw, v.role) });
        if (!gate.ok) return gate.response;
        const data = await fetchDeviceReadings(deviceId, gate.hours ?? DEFAULT_FEED_HOURS);
        return NextResponse.json({ success: true, data, hours: gate.hours });
    } catch (error) {
        return telemetryErrorResponse(error, 'Device Readings');
    }
}
