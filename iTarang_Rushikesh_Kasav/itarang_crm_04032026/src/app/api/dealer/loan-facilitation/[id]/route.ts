import { db } from '@/lib/db';
import { leads, loanApplications } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (_req: Request, ctx: { params: { id: string } }) => {
    const user = await requireRole(['dealer']);
    const id = ctx.params.id;

    const rows = await db
        .select({
            id: loanApplications.id,
            lead_id: loanApplications.lead_id,
            applicant_name: sql<string>`COALESCE(${loanApplications.applicant_name}, ${leads.owner_name})`,
            phone: leads.owner_contact,
            documents_uploaded: loanApplications.documents_uploaded,
            company_validation_status: loanApplications.company_validation_status,
            facilitation_fee_status: loanApplications.facilitation_fee_status,
            facilitation_fee_amount: loanApplications.facilitation_fee_amount,
            application_status: loanApplications.application_status,
            created_at: loanApplications.created_at,
            updated_at: loanApplications.updated_at,
        })
        .from(loanApplications)
        .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
        .where(and(eq(loanApplications.id, id), eq(leads.dealer_id, user.dealer_id!)))
        .limit(1);

    if (!rows.length) return errorResponse('Loan application not found', 404);

    return successResponse(rows[0]);
});