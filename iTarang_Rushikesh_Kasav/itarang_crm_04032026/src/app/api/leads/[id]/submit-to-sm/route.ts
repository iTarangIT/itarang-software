import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['dealer']);
    const leadId = params.id;

    const [lead] = await db.select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        kyc_status: leads.kyc_status,
        sm_review_status: leads.sm_review_status,
    }).from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (lead.dealer_id !== user.dealer_id) return errorResponse('Access denied', 403);
    if (lead.kyc_status !== 'completed') return errorResponse('KYC must be completed before submitting to SM', 400);
    if (lead.sm_review_status !== 'not_submitted') return errorResponse('Lead already submitted to SM', 400);

    await db.update(leads).set({
        sm_review_status: 'pending_sm_review',
        submitted_to_sm_at: new Date(),
        updated_at: new Date(),
    }).where(eq(leads.id, leadId));

    return successResponse({ message: 'Lead submitted to Itarang Sales Manager successfully' });
});
