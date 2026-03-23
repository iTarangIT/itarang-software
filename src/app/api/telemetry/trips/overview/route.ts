import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchTripsOverview } from '@/lib/telemetry/queries';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const data = await fetchTripsOverview(limit);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Trips Overview] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
