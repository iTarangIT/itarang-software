import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const DELETE = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['dealer']);
    const { id } = params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    if (lead.uploader_id !== user.id) return errorResponse('Forbidden', 403);
    if (lead.status !== 'INCOMPLETE') {
        return errorResponse('Only incomplete leads can be discarded', 400);
    }

    await db.transaction(async (tx) => {
        // Mark as ABANDONED instead of hard delete to maintain audit history (as per compliance-ish)
        // Or hard delete if "discard" implies total removal. 
        // Decision: Hard delete because user said "discard" and "cleanup after 7 days".
        await tx.delete(leads).where(eq(leads.id, id));

        // Log discard
        await tx.insert(auditLogs).values({
            id: `AUDIT-${Date.now()}`,
            entity_type: 'lead',
            entity_id: id,
            action: 'delete',
            changes: { status: 'discarded' },
            performed_by: user.id,
            timestamp: new Date()
        });
    });

    return successResponse({ message: 'Lead discarded' });
});
