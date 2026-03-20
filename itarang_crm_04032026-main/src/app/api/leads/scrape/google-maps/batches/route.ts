import { db } from '@/lib/db';
import { scrapeBatches } from '@/lib/db/schema';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { desc } from 'drizzle-orm';

export const GET = withErrorHandler(async () => {
    await requireRole(['ceo', 'sales_head']);

    const batches = await db.select()
        .from(scrapeBatches)
        .orderBy(desc(scrapeBatches.created_at))
        .limit(50);

    return successResponse(batches);
});
