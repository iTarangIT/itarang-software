import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { getAICallerEnabled, setAICallerEnabled } from '@/lib/ai/settings';

export async function GET() {
    try {
        await requireRole(['ceo']);
        const enabled = await getAICallerEnabled();
        return NextResponse.json({ success: true, data: { enabled } });
    } catch (error) {
        console.error('[AI Dialer Settings] GET error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { enabled } = await req.json();

        if (typeof enabled !== 'boolean') {
            return NextResponse.json(
                { success: false, error: { message: 'enabled must be a boolean' } },
                { status: 400 }
            );
        }

        await setAICallerEnabled(enabled);
        console.log(`[AI Dialer Settings] AI caller ${enabled ? 'ENABLED' : 'DISABLED'}`);

        return NextResponse.json({ success: true, data: { enabled } });
    } catch (error) {
        console.error('[AI Dialer Settings] POST error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
