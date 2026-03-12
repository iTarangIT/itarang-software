import { db } from '@/lib/db';
import { leads, loanOffers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['dealer', 'sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const [lead] = await db.select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        sm_review_status: leads.sm_review_status,
    }).from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (user.role === 'dealer' && lead.dealer_id !== user.dealer_id) return errorResponse('Access denied', 403);

    const offers = await db.select().from(loanOffers)
        .where(eq(loanOffers.lead_id, leadId));

    return successResponse({ offers, sm_review_status: lead.sm_review_status });
});
