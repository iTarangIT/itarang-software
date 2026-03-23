import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDeviceById } from '@/lib/telemetry/queries';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
    try {
        await requireRole(['ceo', 'dealer']);
        const { deviceId } = await params;
        const data = await fetchDeviceById(deviceId);
        if (!data) {
            return NextResponse.json({ success: false, error: { message: 'Device not found' } }, { status: 404 });
        }
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Device Detail] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
