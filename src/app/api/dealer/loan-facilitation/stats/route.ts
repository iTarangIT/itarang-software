import { db } from '@/lib/db';
import { leads, loanApplications } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { dealerVisibleLeads } from '@/lib/leads/dealerLeadScope';

const EMPTY_STATS = {
    total: 0,
    fee_pending: 0,
    under_validation: 0,
    validation_passed: 0,
    fee_paid: 0,
};

// Dashboard card stats for Loan Facilitation
export const GET = withErrorHandler(async () => {
    const user = await requireRole(['dealer']);
    // 14 Oct: the house dealer also sees the files it pushed out (dealerLeadScope.ts).
    const visible = await dealerVisibleLeads(user?.dealer_id ?? "");

    let rows: { facilitation_fee_status: string | null; company_validation_status: string }[];
    try {
        rows = await db
            .select({
                facilitation_fee_status: loanApplications.facilitation_fee_status,
                company_validation_status: loanApplications.company_validation_status,
            })
            .from(loanApplications)
            .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
            .where(
                and(
                    visible,
                    eq(loanApplications.documents_uploaded, true)
                )
            );
    } catch {
        // Table or columns may not exist yet — return zeros
        return successResponse(EMPTY_STATS);
    }

    const total = rows.length;
    const feePending = rows.filter(r => (r.facilitation_fee_status || '').toLowerCase() !== 'paid').length;
    const underValidation = rows.filter(r => (r.company_validation_status || '').toLowerCase() === 'pending').length;
    const validationPassed = rows.filter(r => (r.company_validation_status || '').toLowerCase() === 'passed').length;
    const feePaid = rows.filter(r => (r.facilitation_fee_status || '').toLowerCase() === 'paid').length;

    return successResponse({
        total,
        fee_pending: feePending,
        under_validation: underValidation,
        validation_passed: validationPassed,
        fee_paid: feePaid,
    });
});
