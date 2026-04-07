import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { aiCallLogs, leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { runPostCallUpdate } from '@/lib/ai/langgraph/lead-qualification-graph';

// Webhook endpoint — no auth required (Bolna callback)
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        console.log('[Bolna Webhook] Received:', JSON.stringify(body).slice(0, 500));

        const callId = body.call_id || body.id;
        const status = body.status || body.call_status;
        const transcript = body.transcript || body.conversation_transcript || '';
        const recordingUrl = body.recording_url || body.recording || '';
        const duration = body.duration || body.call_duration;

        if (!callId) {
            return NextResponse.json({ success: false, error: 'call_id required' }, { status: 400 });
        }

        // Update call log
        const updates: Record<string, unknown> = {
            status: status || 'completed',
            ended_at: new Date(),
        };
        if (transcript) updates.transcript = transcript;
        if (recordingUrl) updates.recording_url = recordingUrl;

        await db.update(aiCallLogs).set(updates).where(eq(aiCallLogs.call_id, callId));

        // Find lead for this call
        const [callLog] = await db.select({ lead_id: aiCallLogs.lead_id })
            .from(aiCallLogs)
            .where(eq(aiCallLogs.call_id, callId))
            .limit(1);

        if (callLog?.lead_id && transcript) {
            // Run post-call update (re-score + update summary)
            try {
                await runPostCallUpdate(callLog.lead_id, transcript, callId);
            } catch (err) {
                console.error('[Bolna Webhook] Post-call update error:', err);
            }
        }

        // Update lead status
        if (callLog?.lead_id) {
            await db.update(leads).set({
                last_call_status: status || 'completed',
                last_call_outcome: transcript ? 'conversation_completed' : 'no_answer',
                updated_at: new Date(),
            }).where(eq(leads.id, callLog.lead_id));
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[Bolna Webhook] Error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
