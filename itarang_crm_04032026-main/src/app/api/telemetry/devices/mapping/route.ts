import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDevices, createDeviceMapping } from '@/lib/telemetry/queries';
import { v4 as uuidv4 } from 'uuid';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const data = await fetchDevices(limit, 0);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Device Mapping GET] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const body = await req.json();
        const id = `DBM-${uuidv4().slice(0, 8)}`;
        await createDeviceMapping({ id, ...body });
        return NextResponse.json({ success: true, id });
    } catch (error) {
        console.error('[Device Mapping POST] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
