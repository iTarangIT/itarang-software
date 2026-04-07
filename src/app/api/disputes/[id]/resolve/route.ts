import { db } from '@/lib/db';
import { orderDisputes, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const resolveSchema = z.object({
    resolution_details: z.string().min(10, 'Resolution details must be at least 10 chars'),
    action_taken: z.string().min(5, 'Action taken must be at least 5 chars'),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const disputeId = params.id;
    const body = await req.json();
    const result = resolveSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.errors[0].message, 400);
    const { resolution_details, action_taken } = result.data;

    // 1. Fetch Dispute
    const [dispute] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, disputeId)).limit(1);
    if (!dispute) return errorResponse('Dispute not found', 404);
    if (dispute.resolution_status === 'resolved' || dispute.resolution_status === 'closed') {
        return errorResponse('Dispute already resolved/closed', 400);
    }

    // 2. Validate Assignee (Only the assigned person can resolve)
    const user = await requireRole(['inventory_manager', 'sales_head', 'business_head', 'ceo']);
    if (dispute.assigned_to !== user.id && user.role !== 'ceo' && user.role !== 'business_head') {
        return errorResponse('Only the assigned person can resolve this dispute', 403);
    }

    // 3. Resolve
    await db.update(orderDisputes)
        .set({
            resolution_status: 'resolved',
            resolution_details,
            action_taken,
            resolved_by: user.id,
            resolved_at: new Date(),
        })
        .where(eq(orderDisputes.id, disputeId));

    // 4. Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'order_dispute',
        entity_id: disputeId,
        action: 'complete',
        changes: { resolution_details, action_taken },
        performed_by: user.id,
        timestamp: new Date(),
    });

    return successResponse({ message: 'Dispute resolved successfully' });
});
