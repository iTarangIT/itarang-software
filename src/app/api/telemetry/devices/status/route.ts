import { NextResponse } from 'next/server';
import { fetchDeviceStatus } from '@/lib/telemetry/queries';
import { requireTelemetryViewer, telemetryErrorResponse, viewerVehicleScope } from '@/lib/telemetry/vehicleAccess';

export async function GET() {
    try {
        const viewer = await requireTelemetryViewer();
        // ID 181: a dealer gets only its mapped vehicles (none without a dealer code).
        const scope = await viewerVehicleScope(viewer);
        const data = await fetchDeviceStatus(scope ?? undefined);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return telemetryErrorResponse(error, 'Device Status');
    }
}
