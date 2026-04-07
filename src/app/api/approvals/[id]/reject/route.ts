import { db } from '@/lib/db';
import { approvals, deals, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const rejectionSchema = z.object({
    rejection_reason: z.string().min(5, 'Rejection reason is required (min 5 chars)'),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const body = await req.json();
    const result = rejectionSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.errors[0].message, 400);
    const { rejection_reason } = result.data;

    const approvalId = params.id;

    // 1. Fetch Approval record
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval) return errorResponse('Approval record not found', 404);
    if (approval.status !== 'pending') return errorResponse('This approval is already processed', 400);

    // 2. Validate Role Permission
    const user = await requireRole([approval.approver_role]);

    // 3. Process Rejection
    await db.transaction(async (tx) => {
        // Update current approval
        await tx.update(approvals)
            .set({
                status: 'rejected',
                approver_id: user.id,
                decision_at: new Date(),
                rejection_reason,
            })
            .where(eq(approvals.id, approvalId));

        // Update Entity Status
        if (approval.entity_type === 'deal') {
            await tx.update(deals)
                .set({
                    deal_status: 'rejected',
                    rejected_by: user.id,
                    rejected_at: new Date(),
                    rejection_reason,
                    updated_at: new Date(),
                })
                .where(eq(deals.id, approval.entity_id));
        }

        // Audit Log
        await tx.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: approval.entity_type,
            entity_id: approval.entity_id,
            action: 'reject',
            changes: { level: approval.level, reason: rejection_reason },
            performed_by: user.id,
            timestamp: new Date(),
        });
    });

    return successResponse({ message: 'Rejected successfully' });
});
