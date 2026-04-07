import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetDashboardCEO, fetchFleetDashboardDealer } from '@/lib/telemetry/queries';

export async function GET() {
    try {
        const user = await requireRole(['ceo', 'dealer']);
        const data = user.role === 'ceo'
            ? await fetchFleetDashboardCEO()
            : await fetchFleetDashboardDealer(user.dealer_id || '');
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Telemetry Dashboard] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
