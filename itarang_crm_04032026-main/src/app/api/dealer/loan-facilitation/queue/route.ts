import { db } from '@/lib/db';
import { leads, loanApplications } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

// Loan Facilitation Queue (Dealer)
// BRD logic: Payment_Method = Finance/Loan AND documents_uploaded = true AND facilitation_fee_status != PAID
// Payment method is tracked at Lead level in the current schema; docs & fee status are on loan_applications.
export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    const { searchParams } = new URL(req.url);

    // Optional filters (UI pills)
    const filter = (searchParams.get('filter') || '').toLowerCase();
    // filter values supported: uploaded | under_validation | validation_passed | fee_pending

    const baseWhere = and(eq(leads.dealer_id, user.dealer_id!), eq(loanApplications.documents_uploaded, true));

    // Compose additional conditions
    const conditions: any[] = [baseWhere];
    if (filter === 'under_validation') {
        conditions.push(eq(loanApplications.company_validation_status, 'pending'));
    }
    if (filter === 'validation_passed') {
        conditions.push(eq(loanApplications.company_validation_status, 'passed'));
    }
    if (filter === 'fee_pending') {
        conditions.push(eq(loanApplications.facilitation_fee_status, 'pending'));
    }

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
            updated_at: loanApplications.updated_at,
        })
        .from(loanApplications)
        .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
        .where(and(...conditions))
        .orderBy(sql`${loanApplications.updated_at} DESC`)
        .limit(50);

    return successResponse(rows);
});