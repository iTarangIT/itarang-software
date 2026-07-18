import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchSOHTrend } from '@/lib/telemetry/queries';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        // Guard the parse: a non-numeric ?days= yielded NaN, which reached the query as
        // `interval '1 day' * NaN` and returned an empty trend — a silent "no data".
        const parsed = Number.parseInt(searchParams.get('days') || '30', 10);
        const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 30;
        const data = await fetchSOHTrend(days);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[SOH Degradation] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
