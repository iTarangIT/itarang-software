import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { fetchFleetMapData } from '@/lib/telemetry/queries';

function isVpsUnreachable(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|getaddrinfo|connection terminated|IOT_DATABASE_URL is not set/i.test(message);
}

export async function GET() {
    let user;
    try {
        user = await requireRole(['ceo', 'dealer']);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }

    try {
        const dealerId = user.role === 'dealer' ? user.dealer_id || undefined : undefined;
        const data = await fetchFleetMapData(dealerId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        if (isVpsUnreachable(error)) {
            return NextResponse.json({
                success: true,
                degraded: true,
                reason: 'IoT VPS unreachable — start the SSH tunnel to 127.0.0.1:5433 to see live data.',
                data: [],
            });
        }
        console.error('[Fleet Map] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
