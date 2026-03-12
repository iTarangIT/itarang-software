import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';
import { getAICallerEnabled } from '@/lib/ai/settings';

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { leadIds } = await req.json();

        if (!Array.isArray(leadIds) || leadIds.length === 0) {
            return NextResponse.json({ success: false, error: { message: 'leadIds array required' } }, { status: 400 });
        }

        // Check global AI caller toggle
        const aiEnabled = await getAICallerEnabled();
        if (!aiEnabled) {
            return NextResponse.json(
                { success: false, error: { message: 'AI caller is currently disabled. Enable it from the AI Dialer settings.' } },
                { status: 403 }
            );
        }

        const now = new Date();

        // Mark leads as AI-managed
        for (const leadId of leadIds) {
            await db.update(leads).set({
                ai_managed: true,
                ai_owner: 'bolna_agent',
                manual_takeover: false,
                last_ai_action_at: now,
                updated_at: now,
            }).where(eq(leads.id, leadId));
        }

        // Run initial scoring for each lead (non-blocking for large batches)
        const results = [];
        for (const leadId of leadIds.slice(0, 10)) { // Limit to 10 for immediate scoring
            try {
                const result = await runLeadQualification(leadId);
                results.push({ leadId, ...result });
            } catch (err) {
                results.push({ leadId, error: err instanceof Error ? err.message : 'Scoring failed' });
            }
        }

        return NextResponse.json({
            success: true,
            assigned: leadIds.length,
            scored: results.length,
            results,
        });
    } catch (error) {
        console.error('[AI Dialer Assign] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
