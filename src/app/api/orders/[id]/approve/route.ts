import { z } from 'zod';
import { db } from '@/lib/db';
import { orders, approvals, auditLogs, slas } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';
import { triggerN8nWebhook } from '@/lib/n8n';

const approvalSchema = z.object({
    decision: z.enum(['approved', 'rejected']),
    rejection_reason: z.string().optional(),
    comments: z.string().optional(),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id: orderId } = await params;
    const body = await req.json();
    const { decision, rejection_reason, comments } = approvalSchema.parse(body);

    // 1. Get Order
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error('Order not found');

    // 2. Determine current level and required role
    let currentLevel = 0;
    if (order.order_status === 'pi_approval_pending') currentLevel = 1;
    else if (order.order_status === 'pi_approval_l2_pending') currentLevel = 2;
    else if (order.order_status === 'pi_approval_l3_pending') currentLevel = 3;
    else throw new Error('Order is not in an approval state');

    const roleMap: Record<number, string[]> = {
        1: ['sales_head', 'ceo', 'business_head'],
        2: ['business_head', 'ceo'],
        3: ['finance_controller', 'ceo']
    };

    const user = await requireRole(roleMap[currentLevel]);

    // 3. Process Decision
    const result = await db.transaction(async (tx) => {
        const approvalId = await generateId('APP', approvals);

        // Insert approval record
        await tx.insert(approvals).values({
            id: approvalId,
            entity_type: 'order',
            entity_id: orderId,
            level: currentLevel,
            approver_role: user.role,
            status: decision,
            approver_id: user.id,
            decision_at: new Date(),
            rejection_reason,
            comments,
        });

        // Update Order Status
        let nextStatus = '';
        if (decision === 'rejected') {
            nextStatus = 'pi_rejected';
        } else {
            if (currentLevel === 1) nextStatus = 'pi_approval_l2_pending';
            else if (currentLevel === 2) nextStatus = 'pi_approval_l3_pending';
            else if (currentLevel === 3) nextStatus = 'pi_approved';
        }

        const [updatedOrder] = await tx.update(orders)
            .set({ order_status: nextStatus as any, updated_at: new Date() })
            .where(eq(orders.id, orderId))
            .returning();

        // 3.5 SLA Management (SOP 11.1)
        if (nextStatus === 'pi_approved') {
            const deadline = new Date();
            deadline.setHours(deadline.getHours() + 48); // 48h for payment

            await tx.insert(slas).values({
                id: await generateId('SLA', slas),
                entity_type: 'order',
                entity_id: orderId,
                workflow_step: 'procurement_payment',
                status: 'active',
                sla_deadline: deadline,
                assigned_to: user.id, // Proxy for finance
            });
        }

        // Audit Log
        await tx.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: 'order',
            entity_id: orderId,
            action: decision === 'approved' ? 'approve' : 'reject',
            changes: { level: currentLevel, status: nextStatus },
            performed_by: user.id,
        });

        return updatedOrder;
    });

    // 4. Trigger n8n
    try {
        await triggerN8nWebhook('pi-approval-workflow', {
            order_id: orderId,
            decision,
            next_status: result.order_status,
            approver_name: user.name
        });
    } catch (err) {
        console.error('Webhook failed:', err);
    }

    return successResponse(result);
});
