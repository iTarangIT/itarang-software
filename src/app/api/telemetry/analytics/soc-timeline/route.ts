import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchSocTimeline } from '@/lib/telemetry/queries';

// SOC-against-time for one battery, tagged with charging-cycle membership. Feeds
// the Charging Timeline chart on Trip Analytics, which exists so cycle detection
// can be checked by eye. months ∈ {1,3,6}; vehicleno is required.
export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const vehicleno = searchParams.get('vehicleno')?.trim();
        if (!vehicleno) {
            return NextResponse.json(
                { success: false, error: { message: 'vehicleno is required' } },
                { status: 400 },
            );
        }
        const months = parseInt(searchParams.get('months') || '3', 10);
        const month = searchParams.get('month')?.trim() || undefined; // YYYY-MM
        const from = searchParams.get('from')?.trim() || undefined;   // YYYY-MM-DD
        const to = searchParams.get('to')?.trim() || undefined;       // YYYY-MM-DD
        const data = await fetchSocTimeline(vehicleno, { months, month, from, to });
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[SOC Timeline] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
