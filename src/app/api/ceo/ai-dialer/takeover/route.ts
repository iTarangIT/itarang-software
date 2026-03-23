import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { leadId, takeover } = await req.json();

        if (!leadId) {
            return NextResponse.json({ success: false, error: { message: 'leadId required' } }, { status: 400 });
        }

        await db.update(leads).set({
            manual_takeover: takeover !== false, // default true
            ai_managed: takeover === false, // if un-takeover, re-enable AI
            updated_at: new Date(),
        }).where(eq(leads.id, leadId));

        return NextResponse.json({ success: true, leadId, manual_takeover: takeover !== false });
    } catch (error) {
        console.error('[AI Dialer Takeover] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
