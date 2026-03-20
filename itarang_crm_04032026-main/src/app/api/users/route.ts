import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['ceo', 'sales_head', 'business_head']);

    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role');

    const query = db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
    }).from(users);

    const data = role
        ? await query.where(eq(users.role, role))
        : await query;

    return successResponse(data);
});
