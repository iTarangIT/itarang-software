import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const [lead] = await db.select({ id: leads.id, sm_review_status: leads.sm_review_status })
        .from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (!['pending_sm_review', 'under_review'].includes(lead.sm_review_status ?? ''))
        return errorResponse('Lead must be in pending or under review state', 400);

    await db.update(leads).set({
        sm_review_status: 'docs_verified',
        sm_assigned_to: user.id,
        updated_at: new Date(),
    }).where(eq(leads.id, leadId));

    return successResponse({ message: 'Documents marked as verified' });
});
