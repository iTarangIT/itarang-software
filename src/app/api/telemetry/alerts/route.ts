import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchAlerts } from '@/lib/telemetry/queries';

export async function GET(req: NextRequest) {
    try {
        const user = await requireRole(['ceo', 'dealer']);
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const ack = searchParams.get('acknowledged');
        const acknowledged = ack === 'true' ? true : ack === 'false' ? false : undefined;
        const dealerId = user.role === 'dealer' ? user.dealer_id || undefined : undefined;

        const data = await fetchAlerts(limit, acknowledged, dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Alerts] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
