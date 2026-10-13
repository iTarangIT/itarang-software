
import { db } from '@/lib/db';
import { aiCallLogs } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { LEADS_PAGE_ROLES, readsOwnLeadsOnly } from "@/lib/leads/access";
import { requireRole } from "@/lib/auth-utils";
// ID 155: read access = own leads, or a direct report's (manager).
import { leadVisibleTo } from "@/lib/users/team";

// Next 16: route params arrive as a Promise.
export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    // ID 118: signed in, with a role that reaches this screen.
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    const { id } = await ctx.params;

    if (!id) {
        return errorResponse('Lead ID is required', 400);
    }

    // ID 45: a rep reads only leads they own; anything else is "no such lead".
    if (readsOwnLeadsOnly(user.role) && !(await leadVisibleTo(id, user.id))) {
        return errorResponse('Lead not found', 404);
    }

    const logs = await db.select()
        .from(aiCallLogs)
        .where(eq(aiCallLogs.lead_id, id))
        .orderBy(desc(aiCallLogs.created_at));

    return successResponse(logs);
});
