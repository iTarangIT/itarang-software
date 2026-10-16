import { NextRequest, NextResponse } from 'next/server';
import { fetchDevices } from '@/lib/telemetry/queries';
import { resolveTelemetryViewer, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';

export async function GET(req: NextRequest) {
    try {
        const viewer = await resolveTelemetryViewer();
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const offset = parseInt(searchParams.get('offset') || '0');
        // ID 181: a dealer login with no dealer code gets an empty list, not the
        // whole fleet (fetchDevices treats an undefined dealer as "everyone").
        if (viewer.role === 'dealer' && !viewer.dealerCode) {
            return NextResponse.json({ success: true, data: [] });
        }
        const dealerId = viewer.role === 'dealer' ? viewer.dealerCode ?? undefined : undefined;

        const data = await fetchDevices(limit, offset, dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return telemetryErrorResponse(error, 'Telemetry Devices');
    }
}
