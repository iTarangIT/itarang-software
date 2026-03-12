import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getAICallerEnabled } from '@/lib/ai/settings';

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { leadId } = await req.json();

        if (!leadId) {
            return NextResponse.json({ success: false, error: { message: 'leadId required' } }, { status: 400 });
        }

        // Check global AI caller toggle
        const aiEnabled = await getAICallerEnabled();
        if (!aiEnabled) {
            return NextResponse.json(
                { success: false, error: { message: 'AI caller is currently disabled. Enable it from the AI Dialer settings.' } },
                { status: 403 }
            );
        }

        // Force shouldCall by setting high priority temporarily
        const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!lead) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        // Ensure AI managed
        if (!lead.ai_managed) {
            await db.update(leads).set({ ai_managed: true, ai_owner: 'bolna_agent', updated_at: new Date() }).where(eq(leads.id, leadId));
        }

        // Run qualification which will trigger call if score is high
        // For manual "Call Now", we force the call by setting intent high
        await db.update(leads).set({ intent_score: 100, updated_at: new Date() }).where(eq(leads.id, leadId));

        const result = await runLeadQualification(leadId);

        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error('[AI Dialer Call] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
