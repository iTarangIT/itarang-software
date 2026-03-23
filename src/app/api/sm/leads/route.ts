import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { inArray, desc } from 'drizzle-orm';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async () => {
    await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);

    const pendingLeads = await db.select({
        id: leads.id,
        reference_id: leads.reference_id,
        full_name: leads.full_name,
        phone: leads.phone,
        payment_method: leads.payment_method,
        interest_level: leads.interest_level,
        sm_review_status: leads.sm_review_status,
        submitted_to_sm_at: leads.submitted_to_sm_at,
        kyc_status: leads.kyc_status,
        has_co_borrower: leads.has_co_borrower,
        dealer_id: leads.dealer_id,
    })
        .from(leads)
        .where(inArray(leads.sm_review_status as any, ['pending_sm_review', 'under_review', 'docs_verified', 'options_ready']))
        .orderBy(desc(leads.submitted_to_sm_at));

    return successResponse({ leads: pendingLeads });
});
