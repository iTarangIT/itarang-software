import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchSOCTrends } from '@/lib/telemetry/queries';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const days = parseInt(searchParams.get('days') || '30');
        const data = await fetchSOCTrends(days);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[SOC Trends] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
