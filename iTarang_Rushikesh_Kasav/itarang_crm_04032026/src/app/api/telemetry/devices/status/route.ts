import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDeviceStatus } from '@/lib/telemetry/queries';

export async function GET() {
    try {
        await requireRole(['ceo', 'dealer']);
        const data = await fetchDeviceStatus();
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Device Status] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
