import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchDealerComparison } from '@/lib/telemetry/queries';

export async function GET() {
    try {
        await requireRole(['ceo']);
        const data = await fetchDealerComparison();
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Dealer Comparison] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
