import { z } from 'zod';
import { db } from '@/lib/db';
import { orders, slas } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { ORDERS_PAGE_ROLES } from '@/lib/auth/staffPageRoles';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

const uploadPiSchema = z.object({
    pi_url: z.string().url(),
    pi_amount: z.string().or(z.number()),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id: orderId } = await params;
    // ID 143: the roles that can open the order page this is posted from.
    await requireRole([...ORDERS_PAGE_ROLES]);
    const body = await req.json();
    const validated = uploadPiSchema.parse(body);

    const [updatedOrder] = await db.transaction(async (tx) => {
        const [order] = await tx.update(orders)
            .set({
                pi_url: validated.pi_url,
                pi_amount: validated.pi_amount.toString(),
                order_status: 'pi_approval_pending',
                updated_at: new Date()
            })
            .where(eq(orders.id, orderId))
            .returning();

        if (order) {
            // Complete PI Upload SLA
            await tx.update(slas)
                .set({
                    status: 'completed',
                    completed_at: new Date()
                })
                .where(and(
                    eq(slas.entity_id, orderId),
                    eq(slas.workflow_step, 'pi_upload'),
                    eq(slas.status, 'active')
                ));
        }

        return [order];
    });

    if (!updatedOrder) throw new Error('Order not found');

    return successResponse(updatedOrder);
});
