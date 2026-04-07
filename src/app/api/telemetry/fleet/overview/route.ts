import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetDashboardCEO } from '@/lib/telemetry/queries';

export const revalidate = 60;

export async function GET() {
    try {
        await requireRole(['ceo']);
        const data = await fetchFleetDashboardCEO();
        return NextResponse.json({ success: true, data: data.kpis });
    } catch (error) {
        console.error('[Fleet Overview] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
