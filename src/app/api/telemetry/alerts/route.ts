import { NextRequest, NextResponse } from 'next/server';
import { fetchAlerts } from '@/lib/telemetry/queries';
import { requireTelemetryViewer, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';

export async function GET(req: NextRequest) {
    try {
        const viewer = await requireTelemetryViewer();
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const ack = searchParams.get('acknowledged');
        const acknowledged = ack === 'true' ? true : ack === 'false' ? false : undefined;
        // ID 181: a dealer login with no dealer code sees no alerts, not every vehicle's.
        if (viewer.role === 'dealer' && !viewer.dealerCode) {
            return NextResponse.json({ success: true, data: [] });
        }
        const dealerId = viewer.role === 'dealer' ? viewer.dealerCode ?? undefined : undefined;

        const data = await fetchAlerts(limit, acknowledged, dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        return telemetryErrorResponse(error, 'Alerts');
    }
}
