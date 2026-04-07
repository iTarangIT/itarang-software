import { db } from '@/lib/db';
import { leads, loanApplications } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

// NOTE: This is a stubbed "payment" endpoint.
// In production, replace with payment gateway integration + webhook.
export const POST = withErrorHandler(async (_req: Request, ctx: { params: { id: string } }) => {
    const user = await requireRole(['dealer']);
    const id = ctx.params.id;

    // Validate ownership
    const rows = await db
        .select({ id: loanApplications.id })
        .from(loanApplications)
        .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
        .where(and(eq(loanApplications.id, id), eq(leads.dealer_id, user.dealer_id!)))
        .limit(1);

    if (!rows.length) return errorResponse('Loan application not found', 404);

    await db
        .update(loanApplications)
        .set({
            facilitation_fee_status: 'paid',
            application_status: 'processing',
            updated_at: new Date(),
        })
        .where(eq(loanApplications.id, id));

    return successResponse({ id, facilitation_fee_status: 'paid' });
});