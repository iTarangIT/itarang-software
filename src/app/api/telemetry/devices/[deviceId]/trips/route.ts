import { NextRequest, NextResponse } from 'next/server';
import { fetchDeviceTrips } from '@/lib/telemetry/queries';
import { requireVehicleFeedAccess, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';
import { tripLimit } from '@/lib/telemetry/vehicleAccessRules';

// ID 181: a dealer opens only vehicles mapped to it (else 'not found'); every
// open is written to telemetry_location_access_log.
export async function GET(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        const { deviceId } = await params;
        const limit = tripLimit(new URL(req.url).searchParams.get('limit'));
        const gate = await requireVehicleFeedAccess({ deviceId, feed: 'trips', hours: () => null });
        if (!gate.ok) return gate.response;
        const data = await fetchDeviceTrips(deviceId, limit);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return telemetryErrorResponse(error, 'Device Trips');
    }
}
