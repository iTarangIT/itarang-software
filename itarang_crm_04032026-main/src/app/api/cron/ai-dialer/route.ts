import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq, and, lte, sql } from 'drizzle-orm';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';
import { getAICallerEnabled } from '@/lib/ai/settings';

// Vercel cron: runs once per day at 3AM UTC
// Configured in vercel.json: { "path": "/api/cron/ai-dialer", "schedule": "0 3 * * *" }

export async function GET(req: NextRequest) {
    // Verify cron secret (Vercel sets this header automatically for cron jobs)
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Check global AI caller toggle
        const aiEnabled = await getAICallerEnabled();
        if (!aiEnabled) {
            console.log('[AI Dialer Cron] Skipped: AI caller is globally disabled');
            return NextResponse.json({
                success: true,
                skipped: true,
                reason: 'AI caller disabled',
                timestamp: new Date().toISOString(),
            });
        }

        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        // Find AI-managed leads that are due for a call
        const dueLeads = await db
            .select({ id: leads.id })
            .from(leads)
            .where(
                and(
                    eq(leads.ai_managed, true),
                    eq(leads.manual_takeover, false),
                    lte(leads.next_call_at, now),
                    // Prevent duplicate actions within 1 hour
                    sql`(${leads.last_ai_action_at} IS NULL OR ${leads.last_ai_action_at} < ${oneHourAgo.toISOString()})`
                )
            )
            .limit(10); // Process max 10 per cron run to avoid timeouts

        const results: { leadId: string; success: boolean; error?: string }[] = [];

        for (const lead of dueLeads) {
            try {
                await runLeadQualification(lead.id);
                results.push({ leadId: lead.id, success: true });
            } catch (err) {
                console.error(`[AI Dialer Cron] Failed for lead ${lead.id}:`, err);
                results.push({ leadId: lead.id, success: false, error: String(err) });
            }
        }

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        console.log(`[AI Dialer Cron] Processed ${dueLeads.length} leads: ${succeeded} succeeded, ${failed} failed`);

        return NextResponse.json({
            success: true,
            processed: dueLeads.length,
            succeeded,
            failed,
            timestamp: now.toISOString(),
        });
    } catch (error) {
        console.error('[AI Dialer Cron] Error:', error);
        return NextResponse.json({ success: false, error: 'Cron job failed' }, { status: 500 });
    }
}
