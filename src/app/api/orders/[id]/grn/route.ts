import { z } from 'zod';
import { db } from '@/lib/db';
import { orders, inventory, auditLogs } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';

const grnSchema = z.object({
    grn_id: z.string().min(1),
    grn_date: z.string().transform(v => new Date(v)),
    actual_delivery_date: z.string().transform(v => new Date(v)),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id: orderId } = await params;
    const user = await requireRole(['inventory_manager', 'ceo', 'business_head']);
    const body = await req.json();
    const { grn_id, grn_date, actual_delivery_date } = grnSchema.parse(body);

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error('Order not found');

    const result = await db.transaction(async (tx) => {
        // 1. Update Order
        const [updatedOrder] = await tx.update(orders)
            .set({
                grn_id,
                grn_date,
                actual_delivery_date,
                order_status: 'delivered',
                delivery_status: 'delivered',
                updated_at: new Date()
            })
            .where(eq(orders.id, orderId))
            .returning();

        // 2. Finalize Inventory Status (from 'reserved' to 'available' at the destination warehouse)
        const itemIds = (order.order_items as any[]).map(i => i.inventory_id);
        await tx.update(inventory)
            .set({
                status: 'available',
                updated_at: new Date()
            })
            .where(inArray(inventory.id, itemIds));

        // 3. Audit Log
        await tx.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: 'order',
            entity_id: orderId,
            action: 'complete',
            changes: { status: 'delivered', grn_id },
            performed_by: user.id,
        });

        return updatedOrder;
    });

    return successResponse(result);
});
