
import { db } from '@/lib/db';
import { aiCallLogs } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const { id } = params;

    if (!id) {
        return errorResponse('Lead ID is required', 400);
    }

    const logs = await db.select()
        .from(aiCallLogs)
        .where(eq(aiCallLogs.lead_id, id))
        .orderBy(desc(aiCallLogs.created_at));

    return successResponse(logs);
});
