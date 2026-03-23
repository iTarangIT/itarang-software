
import { db } from '@/lib/db';
import { callSessions, callRecords, leads } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { triggerBolnaCall } from '@/lib/bolna';
import { sql, desc, and, or, isNull, lte, eq } from 'drizzle-orm';

export const POST = withErrorHandler(async (req: Request) => {
    // 1. Create call_sessions row
    const sessionId = `SESS-${Date.now()}`;
    await db.insert(callSessions).values({
        session_id: sessionId,
        status: 'active',
        created_at: new Date()
    });

    // 2. Rank Leads (Internal logic similar to rank-leads API)
    const now = new Date();
    const [topLead] = await db.select()
        .from(leads)
        .where(
            and(
                eq(leads.do_not_call, false),
                or(
                    isNull(leads.next_call_after),
                    lte(leads.next_call_after, now)
                )
            )
        )
        .orderBy(
            desc(sql`CASE 
                WHEN ${leads.interest_level} = 'hot' THEN 3 
                WHEN ${leads.interest_level} = 'warm' THEN 2 
                ELSE 1 
            END`),
            desc(sql`CASE WHEN ${leads.last_ai_call_at} IS NULL THEN 1 ELSE 0 END`),
            leads.last_ai_call_at
        )
        .limit(1);

    if (!topLead) {
        return errorResponse('No leads available to call', 404);
    }

    // 3. Create call_record with session_id
    const callId = await generateId('CALL', callRecords);
    await db.insert(callRecords).values({
        id: callId,
        session_id: sessionId,
        lead_id: topLead.id,
        status: 'queued',
        created_at: new Date()
    });

    // 4. Trigger Bolna
    const result = await triggerBolnaCall(topLead.owner_contact, topLead.id, topLead);

    if (!result.success) {
        await db.update(callRecords).set({ status: 'failed' }).where(eq(callRecords.id, callId));
        return errorResponse('Failed to trigger first call: ' + result.error, 500);
    }

    // 5. Update Record success
    await db.update(callRecords)
        .set({ bolna_call_id: result.callId, status: 'ringing' })
        .where(eq(callRecords.id, callId));

    return successResponse({
        sessionId,
        callRecordId: callId,
        bolnaCallId: result.callId,
        leadName: topLead.owner_name,
        message: 'Autonomous session started'
    });
});
