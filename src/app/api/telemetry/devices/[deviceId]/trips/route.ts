import { NextRequest, NextResponse } from 'next/server';
import { fetchDeviceTrips } from '@/lib/telemetry/queries';
import { requireVehicleFeedAccess, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';
import { tripLimit, tripWindowHours } from '@/lib/telemetry/vehicleAccessRules';

// ID 181: a dealer opens only vehicles mapped to it (else 'not found') and
// gets only trips that started in the last 7 days (same cap as the GPS trail;
// the CEO is uncapped); every open is written to telemetry_location_access_log
// with the window served in `hours`.
export async function GET(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        const { deviceId } = await params;
        const limit = tripLimit(new URL(req.url).searchParams.get('limit'));
        const gate = await requireVehicleFeedAccess({ deviceId, feed: 'trips', hours: (v) => tripWindowHours(v.role) });
        if (!gate.ok) return gate.response;
        const data = await fetchDeviceTrips(deviceId, limit, gate.hours);
        return NextResponse.json({ success: true, data, hours: gate.hours });
    } catch (error) {
        return telemetryErrorResponse(error, 'Device Trips');
    }
}
