import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    return successResponse(user);
});
