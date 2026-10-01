
import { db } from '@/lib/db';
import { aiCallLogs } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { requireRole } from "@/lib/auth-utils";

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    // ID 118: signed in, with a role that reaches this screen.
    await requireRole([...LEADS_PAGE_ROLES]);
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
