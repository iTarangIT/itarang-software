import { db } from '@/lib/db';
import { leads, loanApplications } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

/**
 * Audience estimate for dealer campaigns.
 * This is intentionally simple (BRD-friendly + fast). Extend as segmentation grows.
 */
export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    const body = await req.json().catch(() => ({}));
    const segment = String(body?.segment || '').trim();

    if (!segment) return errorResponse('segment is required', 400);

    // Segments implemented:
    // - all_customers
    // - hot_leads
    // - pending_loans
    // - inactive_customers (placeholder: leads with status "lost" OR not updated in 30 days)

    if (segment === 'all_customers') {
        const [{ count }] = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(leads)
            .where(eq(leads.dealer_id, user.dealer_id!));
        return successResponse({ count });
    }

    if (segment === 'hot_leads') {
        const [{ count }] = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(leads)
            .where(and(eq(leads.dealer_id, user.dealer_id!), eq(leads.interest_level, 'hot')));
        return successResponse({ count });
    }

    if (segment === 'pending_loans') {
        const [{ count }] = await db
            .select({ count: sql<number>`COUNT(DISTINCT ${leads.id})` })
            .from(loanApplications)
            .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
            .where(
                and(
                    eq(leads.dealer_id, user.dealer_id!),
                    eq(loanApplications.application_status, 'processing')
                )
            );
        return successResponse({ count });
    }

    if (segment === 'inactive_customers') {
        // Approximation: leads not updated in last 30 days OR marked lost.
        const [{ count }] = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(leads)
            .where(
                and(
                    eq(leads.dealer_id, user.dealer_id!),
                    sql`(${leads.updated_at} < NOW() - INTERVAL '30 days' OR ${leads.lead_status} = 'lost')`
                )
            );
        return successResponse({ count });
    }

    return errorResponse('Unknown segment', 400);
});