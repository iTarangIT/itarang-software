import { z } from 'zod';
import { db } from '@/lib/db';
import { orders, auditLogs, slas } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';

const paymentSchema = z.object({
    amount: z.string().or(z.number()),
    mode: z.enum(['cash', 'bank_transfer', 'cheque', 'online']),
    transaction_id: z.string().min(1),
    payment_date: z.string().transform(v => new Date(v)),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id: orderId } = await params;
    const user = await requireRole(['finance_controller', 'ceo']);
    const body = await req.json();
    const validated = paymentSchema.parse(body);

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error('Order not found');

    const totalPaid = parseFloat(order.payment_amount) + parseFloat(validated.amount.toString());
    const totalOrder = parseFloat(order.total_amount);

    let paymentStatus = 'partial';
    if (totalPaid >= totalOrder) {
        paymentStatus = 'paid';
    }

    const [updatedOrder] = await db.transaction(async (tx) => {
        const [orderUpdate] = await tx.update(orders)
            .set({
                payment_status: paymentStatus as any,
                payment_amount: totalPaid.toString(),
                payment_mode: validated.mode,
                transaction_id: validated.transaction_id,
                payment_date: validated.payment_date,
                order_status: paymentStatus === 'paid' ? 'payment_made' : order.order_status as any,
                updated_at: new Date()
            })
            .where(eq(orders.id, orderId))
            .returning();

        if (orderUpdate) {
            // Complete Payment SLA (SOP 11.1)
            await tx.update(slas)
                .set({
                    status: 'completed',
                    completed_at: new Date()
                })
                .where(and(
                    eq(slas.entity_id, orderId),
                    eq(slas.workflow_step, 'procurement_payment'),
                    eq(slas.status, 'active')
                ));
        }

        return [orderUpdate];
    });

    // Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'order',
        entity_id: orderId,
        action: 'update',
        changes: { payment_status: paymentStatus, amount_paid: validated.amount },
        performed_by: user.id,
    });

    return successResponse(updatedOrder);
});
