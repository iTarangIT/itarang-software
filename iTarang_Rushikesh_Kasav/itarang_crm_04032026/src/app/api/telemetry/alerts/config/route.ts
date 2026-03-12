import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchAlertConfig, updateAlertConfig } from '@/lib/telemetry/queries';

export async function GET() {
    try {
        await requireRole(['ceo']);
        const data = await fetchAlertConfig();
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[Alert Config GET] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { alert_type, threshold, severity } = await req.json();
        if (!alert_type) {
            return NextResponse.json({ success: false, error: { message: 'alert_type required' } }, { status: 400 });
        }
        await updateAlertConfig(alert_type, threshold, severity);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[Alert Config PUT] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
