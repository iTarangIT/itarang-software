import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetLocations } from '@/lib/telemetry/queries';

// Distinct State/City options for the Fleet Overview filter dropdowns. Reads the
// RDS device_battery_map only (not the VPS), so no tunnel-degraded path here.
export async function GET() {
    let user;
    try {
        user = await requireRole(['ceo', 'dealer']);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }

    try {
        const dealerId = user.role === 'dealer' ? user.dealer_id || undefined : undefined;
        const data = await fetchFleetLocations(dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Fleet Locations] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
