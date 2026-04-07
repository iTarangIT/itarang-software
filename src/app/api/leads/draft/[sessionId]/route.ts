import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq, and } from 'drizzle-orm';

export const DELETE = withErrorHandler(async (_req: Request, { params }: { params: { sessionId: string } }) => {
    const user = await requireRole(['dealer']);
    const { sessionId } = params;

    let existing;
    try {
        [existing] = await db.select().from(leads).where(eq(leads.id, sessionId)).limit(1);
    } catch (err) {
        console.error("Draft lookup failed:", err);
        return errorResponse("Failed to find lead draft. Please try again.", 500);
    }

    if (!existing) {
        return errorResponse('Draft not found', 404);
    }

    if (existing.uploader_id !== user.id) {
        return errorResponse('Forbidden: You do not have permission to delete this draft', 403);
    }

    if (existing.status !== 'INCOMPLETE') {
        return errorResponse('Only incomplete drafts can be deleted', 400);
    }

    try {
        await db.transaction(async (tx) => {
            await tx.delete(leads).where(eq(leads.id, sessionId));

            await tx.insert(auditLogs).values({
                id: `AUDIT-${Date.now()}`,
                entity_type: 'lead',
                entity_id: sessionId,
                action: 'DRAFT_DELETED',
                changes: { status: 'DELETED' },
                performed_by: user.id,
                timestamp: new Date()
            });
        });

        return successResponse({ success: true, message: 'Draft deleted' });
    } catch (err) {
        console.error("Draft deletion failed:", err);
        return errorResponse("Something went wrong while deleting the draft. Please try again.", 500);
    }
});
