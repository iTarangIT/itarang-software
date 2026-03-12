
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireAuth } from '@/lib/auth-utils';
import { triggerBolnaCall } from '@/lib/bolna';
import { db } from '@/lib/db';
import { leads, callRecords } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const POST = withErrorHandler(async (req: Request) => {
    // 1. Authenticate user
    await requireAuth();

    // 2. Parse request body
    const { leadId } = await req.json();

    if (!leadId) {
        return errorResponse('Lead ID is required', 400);
    }

    // 3. Fetch lead details
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) {
        return errorResponse('Lead not found', 404);
    }

    if (!lead.owner_contact) {
        return errorResponse('Lead has no contact number', 400);
    }

    // 4. Generate CALL ID and Insert into call_records BEFORE calling Bolna
    const callId = await generateId('CALL', callRecords);

    await db.insert(callRecords).values({
        id: callId,
        lead_id: leadId,
        status: 'queued',
        created_at: new Date(),
    });

    // 5. Trigger Bolna call
    const result = await triggerBolnaCall(lead.owner_contact, lead.id, lead);

    if (!result.success) {
        // If failed → mark call_records.status = 'failed'
        await db.update(callRecords)
            .set({ status: 'failed' })
            .where(eq(callRecords.id, callId));

        return errorResponse(result.error || 'Failed to trigger Bolna call', 500);
    }

    // 6. If success → update bolna_call_id and status = 'ringing'
    await db.update(callRecords)
        .set({
            bolna_call_id: result.callId,
            status: 'ringing'
        })
        .where(eq(callRecords.id, callId));

    return successResponse({
        message: 'Call triggered successfully',
        callId: result.callId,
        callRecordId: callId
    });
});
