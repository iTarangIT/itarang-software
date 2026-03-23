import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDeviceGPS } from '@/lib/telemetry/queries';

export async function GET(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        await requireRole(['ceo', 'dealer']);
        const { deviceId } = await params;
        const { searchParams } = new URL(req.url);
        const hours = parseInt(searchParams.get('hours') || '24');
        const data = await fetchDeviceGPS(deviceId, hours);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Device GPS] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
