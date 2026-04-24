import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

// kyc_status values that indicate the lead is currently in a Step 3 "dealer
// action required" state and is being re-submitted after the dealer has
// uploaded the requested docs / co-borrower info.
const STEP_3_AWAITING_STATES = new Set([
    'awaiting_additional_docs',
    'awaiting_co_borrower_kyc',
    'awaiting_co_borrower_replacement',
    'awaiting_doc_reupload',
    'awaiting_both',
]);

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

    const currentKycStatus = String(lead.kyc_status || '');
    const isStep3Resubmission = STEP_3_AWAITING_STATES.has(currentKycStatus);

    // Step 3 re-submission path: dealer is re-submitting after admin requested
    // additional docs / co-borrower. Transition kyc_status to
    // pending_itarang_reverification so the admin queue picks this up as a
    // Step 3 review (BRD V2 Part D, §3644).
    if (isStep3Resubmission) {
        await db.update(leads).set({
            kyc_status: 'pending_itarang_reverification',
            sm_review_status: 'pending_sm_review',
            submitted_to_sm_at: new Date(),
            updated_at: new Date(),
        }).where(eq(leads.id, leadId));

        return successResponse({
            message: 'Submitted for iTarang re-verification.',
            kyc_status: 'pending_itarang_reverification',
        });
    }

    // Original Step 2 → SM review path
    if (currentKycStatus !== 'completed') return errorResponse('KYC must be completed before submitting to SM', 400);
    if (lead.sm_review_status !== 'not_submitted') return errorResponse('Lead already submitted to SM', 400);

    await db.update(leads).set({
        sm_review_status: 'pending_sm_review',
        submitted_to_sm_at: new Date(),
        updated_at: new Date(),
    }).where(eq(leads.id, leadId));

    return successResponse({ message: 'Lead submitted to Itarang Sales Manager successfully' });
});
