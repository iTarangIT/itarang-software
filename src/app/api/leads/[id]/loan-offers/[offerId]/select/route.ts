import { db } from '@/lib/db';
import { leads, loanOffers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string; offerId: string } }) => {
    const user = await requireRole(['dealer']);
    const { id: leadId, offerId } = params;

    const [lead] = await db.select({ dealer_id: leads.dealer_id, sm_review_status: leads.sm_review_status })
        .from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (lead.dealer_id !== user.dealer_id) return errorResponse('Access denied', 403);
    if (lead.sm_review_status !== 'options_ready') return errorResponse('Loan options are not yet available', 400);

    const [offer] = await db.select().from(loanOffers)
        .where(and(eq(loanOffers.id, offerId), eq(loanOffers.lead_id, leadId))).limit(1);

    if (!offer) return errorResponse('Offer not found', 404);

    // Reset any previously selected offer for this lead, then select this one
    await db.update(loanOffers).set({ status: 'offered', updated_at: new Date() })
        .where(and(eq(loanOffers.lead_id, leadId), eq(loanOffers.status as any, 'selected')));

    await db.update(loanOffers).set({ status: 'selected', updated_at: new Date() })
        .where(eq(loanOffers.id, offerId));

    return successResponse({ message: 'Offer selected', offer_id: offerId });
});
