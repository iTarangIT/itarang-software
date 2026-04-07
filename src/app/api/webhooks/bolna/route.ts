
import { db } from '@/lib/db';
import { leads, auditLogs, users, callRecords, conversationMessages, callSessions } from '@/lib/db/schema';
import { eq, sql, desc } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { triggerBolnaCall } from '@/lib/bolna';

export const POST = withErrorHandler(async (req: Request) => {
    const body = await req.json();

    const {
        call_id,
        agent_id,
        user_number,
        conversation_duration,
        transcript,
        summary,
        recording_url,
        status,
        metadata
    } = body;

    let leadId = metadata?.lead_id;

    // 1. Identify or Create Call Record
    let [callRecord] = await db.select().from(callRecords).where(eq(callRecords.bolna_call_id, call_id)).limit(1);

    if (!callRecord) {
        // Fallback: If no record found, try to find lead and create one
        if (!leadId && user_number) {
            const cleanNumber = user_number.replace(/\D/g, '').slice(-10);
            const [leadByPhone] = await db.select().from(leads)
                .where(sql`${leads.owner_contact} LIKE ${'%' + cleanNumber}`).limit(1);
            if (leadByPhone) leadId = leadByPhone.id;
        }

        if (leadId) {
            const newRecordId = await generateId('CALL', callRecords);
            await db.insert(callRecords).values({
                id: newRecordId,
                lead_id: leadId,
                bolna_call_id: call_id,
                status: 'completed',
                created_at: new Date()
            });
            [callRecord] = await db.select().from(callRecords).where(eq(callRecords.id, newRecordId)).limit(1);
        }
    }

    if (!callRecord) {
        return errorResponse('Could not identify call record or lead', 400);
    }

    leadId = callRecord.lead_id;

    // 2. Parse Transcript and Store Messages
    if (transcript) {
        const lines = transcript.split('\n');
        for (const line of lines) {
            const match = line.match(/^(Assistant|User):\s*(.*)$/i);
            if (match) {
                const role = match[1].toLowerCase() === 'assistant' ? 'assistant' : 'user';
                const message = match[2].trim();
                if (message) {
                    await db.insert(conversationMessages).values({
                        call_record_id: callRecord.id,
                        role: role as any,
                        message: message,
                        timestamp: new Date()
                    });
                }
            }
        }
    }

    // 3. Update Call Record
    await db.update(callRecords).set({
        status: 'completed',
        duration_seconds: conversation_duration,
        recording_url: recording_url,
        summary: summary,
        transcript: transcript,
        ended_at: new Date()
    }).where(eq(callRecords.id, callRecord.id));

    // 4. Update Lead AI Counters and Outcome
    const outcome = summary?.toLowerCase().includes('interested') ? 'interested' : 'not_interested';
    await db.update(leads).set({
        total_ai_calls: sql`${leads.total_ai_calls} + 1`,
        last_ai_call_at: new Date(),
        last_call_outcome: outcome,
        updated_at: new Date()
    }).where(eq(leads.id, leadId));

    // 5. Phase B: Autonomous Loop
    if (callRecord.session_id) {
        const [session] = await db.select().from(callSessions).where(eq(callSessions.session_id, callRecord.session_id)).limit(1);

        if (session && session.status === 'active') {
            // Trigger Next Call Logic (MVP version)
            // Fetch next ranked lead
            const [nextLead] = await db.select()
                .from(leads)
                .where(sql`${leads.do_not_call} = false AND (${leads.next_call_after} IS NULL OR ${leads.next_call_after} <= NOW())`)
                .orderBy(desc(leads.ai_priority_score), leads.last_ai_call_at)
                .limit(1);

            if (nextLead) {
                const nextCallId = await generateId('CALL', callRecords);
                await db.insert(callRecords).values({
                    id: nextCallId,
                    session_id: session.session_id,
                    lead_id: nextLead.id,
                    status: 'queued',
                    created_at: new Date()
                });

                const result = await triggerBolnaCall(nextLead.owner_contact, nextLead.id, nextLead);
                if (result.success) {
                    await db.update(callRecords)
                        .set({ bolna_call_id: result.callId, status: 'ringing' })
                        .where(eq(callRecords.id, nextCallId));
                } else {
                    await db.update(callRecords)
                        .set({ status: 'failed' })
                        .where(eq(callRecords.id, nextCallId));
                }
            } else {
                // No more leads, close session
                await db.update(callSessions)
                    .set({ status: 'completed', ended_at: new Date() })
                    .where(eq(callSessions.session_id, session.session_id));
            }
        }
    }

    return successResponse({
        call_record_id: callRecord.id,
        status: 'processed'
    });
});
