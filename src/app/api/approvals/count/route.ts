import { db } from '@/lib/db';
import { approvals } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async () => {
    const user = await requireAuth();

    // Map roles to what they can approve
    const roleMapping: Record<string, string[]> = {
        'sales_head': ['sales_head'],
        'business_head': ['business_head'],
        'finance_controller': ['finance_controller'],
        'ceo': ['sales_head', 'business_head', 'finance_controller'] // CEO can see all or specific (usually all)
    };

    const targetRoles = roleMapping[user.role];

    if (!targetRoles) {
        return successResponse({ count: 0 });
    }

    const [result] = await db.select({
        count: sql<number>`count(*)::int`
    })
        .from(approvals)
        .where(
            and(
                eq(approvals.status, 'pending'),
                sql`${approvals.approver_role} IN ${targetRoles}`
            )
        );

    return successResponse({ count: result.count || 0 });
});
