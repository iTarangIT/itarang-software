import { db } from '@/lib/db';
import { leads, loanOffers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const [lead] = await db.select({ id: leads.id, sm_review_status: leads.sm_review_status })
        .from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (lead.sm_review_status !== 'docs_verified')
        return errorResponse('Documents must be verified before sharing options', 400);

    // Ensure at least one offer exists
    const offers = await db.select({ id: loanOffers.id }).from(loanOffers).where(eq(loanOffers.lead_id, leadId)).limit(1);
    if (offers.length === 0) return errorResponse('Add at least one loan offer before sharing with dealer', 400);

    // Mark all pending offers as offered
    await db.update(loanOffers).set({ status: 'offered', updated_at: new Date() })
        .where(eq(loanOffers.lead_id, leadId));

    await db.update(leads).set({
        sm_review_status: 'options_ready',
        updated_at: new Date(),
    }).where(eq(leads.id, leadId));

    return successResponse({ message: 'Loan options shared with dealer' });
});
