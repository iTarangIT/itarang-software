/**
 * GET /api/user/list?role=sales_manager
 * Returns active users, optionally filtered by role.
 * Used by the AssignLeadModal to populate the assignee dropdown.
 */

import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq, and } from 'drizzle-orm';

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['sales_head', 'ceo', 'business_head', 'sales_manager']);

    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role');

    const conditions = [eq(users.is_active, true)];
    if (role) {
        conditions.push(eq(users.role, role));
    }

    const rows = await db
        .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
        })
        .from(users)
        .where(and(...conditions))
        .orderBy(users.name);

    if (rows.length === 0 && role) {
        return errorResponse(`No active users found with role: ${role}`, 404);
    }

    return successResponse(rows);
});
