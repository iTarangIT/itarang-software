import { db } from '@/lib/db';
import { dealerSubscriptions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();

    if (!user.dealer_id) {
        return successResponse(null);
    }

    const subs = await db
        .select()
        .from(dealerSubscriptions)
        .where(eq(dealerSubscriptions.dealer_id, user.dealer_id))
        .limit(1);

    return successResponse(subs[0] || null);
});
