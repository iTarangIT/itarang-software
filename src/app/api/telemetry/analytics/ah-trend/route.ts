import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchBatteryAhAnalytics } from '@/lib/telemetry/queries';

// Per-battery Amp-Hour analytics (AH trend, capacity trend, charging stats) for
// the Trip Analytics tab. months ∈ {1,3,6}; vehicleno is required.
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
        const data = await fetchBatteryAhAnalytics(vehicleno, { months, month, from, to });
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[AH Trend] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
