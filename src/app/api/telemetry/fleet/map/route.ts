import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetMapData } from '@/lib/telemetry/queries';
import { isVpsUnreachable, vpsDegradedReason } from '@/lib/telemetry/vps-status';

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
        const data = await fetchFleetMapData(dealerId);
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
