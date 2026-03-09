import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq, and, desc, asc, sql } from 'drizzle-orm';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { searchParams } = new URL(req.url);
        const limit = parseInt(searchParams.get('limit') || '50');

        const queue = await db.select({
            id: leads.id,
            reference_id: leads.reference_id,
            full_name: leads.full_name,
            owner_name: leads.owner_name,
            phone: leads.phone,
            owner_contact: leads.owner_contact,
            interest_level: leads.interest_level,
            lead_status: leads.lead_status,
            asset_model: leads.asset_model,
            intent_score: leads.intent_score,
            intent_reason: leads.intent_reason,
            call_priority: leads.call_priority,
            next_call_at: leads.next_call_at,
            last_call_status: leads.last_call_status,
            last_ai_call_at: leads.last_ai_call_at,
            total_ai_calls: leads.total_ai_calls,
            conversation_summary: leads.conversation_summary,
            ai_managed: leads.ai_managed,
            manual_takeover: leads.manual_takeover,
        })
        .from(leads)
        .where(and(eq(leads.ai_managed, true), eq(leads.manual_takeover, false)))
        .orderBy(desc(leads.call_priority), asc(leads.next_call_at))
        .limit(limit);

        return NextResponse.json({ success: true, data: queue });
    } catch (error) {
        console.error('[AI Dialer Queue] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
