import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { acknowledgeAlert } from '@/lib/telemetry/queries';

export async function POST(req: NextRequest) {
    try {
        const user = await requireRole(['ceo', 'dealer']);
        const { alertId } = await req.json();
        if (!alertId) {
            return NextResponse.json({ success: false, error: { message: 'alertId required' } }, { status: 400 });
        }
        await acknowledgeAlert(alertId, user.email || user.id);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[Acknowledge Alert] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
