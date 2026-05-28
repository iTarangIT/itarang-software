import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetDashboardCEO } from '@/lib/telemetry/queries';

// requireRole() reads cookies → route is inherently dynamic and cannot be
// statically prerendered. The previous `revalidate = 60` conflicted with that
// and made static generation throw DYNAMIC_SERVER_USAGE on every deploy.
export const dynamic = 'force-dynamic';

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
