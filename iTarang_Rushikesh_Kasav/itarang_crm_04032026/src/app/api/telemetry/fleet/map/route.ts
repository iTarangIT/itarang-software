import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetMapData } from '@/lib/telemetry/queries';

export async function GET() {
    try {
        const user = await requireRole(['ceo', 'dealer']);
        const dealerId = user.role === 'dealer' ? user.dealer_id || undefined : undefined;
        const data = await fetchFleetMapData(dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Fleet Map] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
