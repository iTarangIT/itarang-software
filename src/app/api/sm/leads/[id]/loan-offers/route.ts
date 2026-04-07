import { db } from '@/lib/db';
import { leads, loanOffers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const offerSchema = z.object({
    financier_name: z.string().min(1),
    loan_amount: z.number().positive(),
    interest_rate: z.number().positive(),
    tenure_months: z.number().int().positive(),
    emi: z.number().positive(),
    processing_fee: z.number().min(0).optional(),
    notes: z.string().optional(),
});

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const offers = await db.select().from(loanOffers).where(eq(loanOffers.lead_id, leadId));
    return successResponse({ offers });
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const [lead] = await db.select({ id: leads.id, sm_review_status: leads.sm_review_status })
        .from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (!['docs_verified', 'options_ready'].includes(lead.sm_review_status ?? ''))
        return errorResponse('Documents must be verified before adding loan offers', 400);

    const body = await req.json();
    const result = offerSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation failed', 400);

    const { financier_name, loan_amount, interest_rate, tenure_months, emi, processing_fee, notes } = result.data;

    const id = await generateId('OFFER', loanOffers);
    await db.insert(loanOffers).values({
        id,
        lead_id: leadId,
        financier_name,
        loan_amount: loan_amount.toString(),
        interest_rate: interest_rate.toString(),
        tenure_months,
        emi: emi.toString(),
        processing_fee: processing_fee?.toString(),
        notes,
        status: 'pending',
        created_by: user.id,
    });

    return successResponse({ id, message: 'Loan offer added' }, 201);
});
