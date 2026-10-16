import { NextRequest, NextResponse } from 'next/server';
import { requireTelemetryViewer, telemetryErrorResponse } from '@/lib/telemetry/vehicleAccess';
import { fetchFleetMapData } from '@/lib/telemetry/queries';
import { isVpsUnreachable, vpsDegradedReason } from '@/lib/telemetry/vps-status';

export async function GET(req: NextRequest) {
    let user;
    try {
        user = await requireTelemetryViewer();
    } catch (error) {
        return telemetryErrorResponse(error, 'Fleet Map');
    }

    try {
        const { searchParams } = new URL(req.url);
        // ID 181: a dealer login with no dealer code sees nothing, not the whole fleet.
        if (user.role === 'dealer' && !user.dealerCode) {
            return NextResponse.json({ success: true, data: [] });
        }
        const dealerId = user.role === 'dealer' ? user.dealerCode ?? undefined : undefined;
        // Location filters apply to the CEO fleet view; dealers stay scoped to
        // their own vehicles regardless of the params.
        const state = user.role === 'ceo' ? searchParams.get('state')?.trim() || undefined : undefined;
        const city = user.role === 'ceo' ? searchParams.get('city')?.trim() || undefined : undefined;
        const data = await fetchFleetMapData({ dealerId, state, city });
        return NextResponse.json({ success: true, data });
    } catch (error) {
        if (isVpsUnreachable(error)) {
            return NextResponse.json({
                success: true,
                degraded: true,
                reason: vpsDegradedReason(error),
                data: [],
            });
        }
        console.error('[Fleet Map] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
