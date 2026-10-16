import { NextResponse } from 'next/server';
import { resolveTelemetryViewer, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';
import { fetchFleetLocations } from '@/lib/telemetry/queries';

// Distinct State/City options for the Fleet Overview filter dropdowns. Reads the
// RDS device_battery_map only (not the VPS), so no tunnel-degraded path here.
export async function GET() {
    let user;
    try {
        user = await resolveTelemetryViewer();
    } catch (error) {
        return telemetryErrorResponse(error, 'Fleet Locations');
    }

    try {
        // ID 181: a dealer login with no dealer code gets no locations, not the whole fleet's.
        if (user.role === 'dealer' && !user.dealerCode) {
            return NextResponse.json({ success: true, data: { states: [], citiesByState: {} } });
        }
        const dealerId = user.role === 'dealer' ? user.dealerCode ?? undefined : undefined;
        const data = await fetchFleetLocations(dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Fleet Locations] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
