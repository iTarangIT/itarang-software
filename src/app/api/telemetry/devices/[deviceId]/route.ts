import { NextRequest, NextResponse } from 'next/server';
import { fetchDeviceById } from '@/lib/telemetry/queries';
import { requireVehicleFeedAccess, telemetryErrorResponse, vehicleNotFound } from '@/lib/telemetry/vehicleAccess';

// ID 181: a dealer opens only vehicles mapped to it (else 'not found'); every
// open is written to telemetry_location_access_log.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        const { deviceId } = await params;
        const gate = await requireVehicleFeedAccess({ deviceId, feed: 'details', hours: () => null });
        if (!gate.ok) return gate.response;
        const data = await fetchDeviceById(deviceId);
        if (!data) return vehicleNotFound();
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return telemetryErrorResponse(error, 'Device Detail');
    }
}
