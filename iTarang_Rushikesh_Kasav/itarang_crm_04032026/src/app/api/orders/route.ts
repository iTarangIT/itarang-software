import { z } from 'zod';
import { db } from '@/lib/db';
import { orders, inventory, provisions, slas } from '@/lib/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';
import { triggerN8nWebhook } from '@/lib/n8n';

const orderSchema = z.object({
    provision_id: z.string().min(1),
    oem_id: z.string().min(1),
    inventory_items: z.array(z.string()).min(1), // IDs from inventory table
    payment_term: z.enum(['advance', 'credit']),
    credit_period_days: z.number().int().optional(),
    expected_delivery_date: z.string().transform(v => new Date(v)),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['inventory_manager', 'ceo', 'business_head']);
    const body = await req.json();
    const validated = orderSchema.parse(body);

    // 1. Validate Inventory Items are 'available' (PDI Pass)
    const items = await db.select()
        .from(inventory)
        .where(inArray(inventory.id, validated.inventory_items));

    if (items.length !== validated.inventory_items.length) {
        throw new Error('Some inventory items not found');
    }

    const unavailableItems = items.filter(i => i.status !== 'available');
    if (unavailableItems.length > 0) {
        throw new Error(`Items ${unavailableItems.map(i => i.id).join(', ')} are not 'available' (PDI Pass required)`);
    }

    // 2. Calculate Total Amount
    const totalAmount = items.reduce((sum, item) => sum + parseFloat(item.final_amount), 0);

    const orderId = await generateId('ORD', orders);

    // 3. Create Order & Update Inventory Status
    const result = await db.transaction(async (tx) => {
        const [newOrder] = await tx.insert(orders).values({
            id: orderId,
            provision_id: validated.provision_id,
            oem_id: validated.oem_id,
            order_items: items.map(i => ({
                inventory_id: i.id,
                serial_number: i.serial_number,
                amount: i.final_amount
            })) as any,
            total_amount: totalAmount.toString(),
            payment_term: validated.payment_term,
            credit_period_days: validated.credit_period_days,
            expected_delivery_date: validated.expected_delivery_date,
            order_status: 'pi_awaited',
            created_by: user.id,
        }).returning();

        // Initialize SLA (SOP 11.1: 24h for PI upload)
        const deadline = new Date();
        deadline.setHours(deadline.getHours() + 24);

        await tx.insert(slas).values({
            id: await generateId('SLA', slas),
            entity_type: 'order',
            entity_id: orderId,
            workflow_step: 'pi_upload',
            status: 'active',
            sla_deadline: deadline,
            assigned_to: user.id,
        });

        // Update inventory to 'reserved' (assigned to order)
        await tx.update(inventory)
            .set({ status: 'reserved' })
            .where(inArray(inventory.id, validated.inventory_items));

        return newOrder;
    });

    // Trigger n8n webhook
    try {
        await triggerN8nWebhook('order-created-request-pi', {
            order_id: orderId,
            total_amount: totalAmount,
            oem_id: validated.oem_id
        });
    } catch (err) {
        console.error('Webhook failed:', err);
    }

    return successResponse(result, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['inventory_manager', 'ceo', 'business_head', 'finance_controller', 'sales_head']);

    const results = await db.select()
        .from(orders)
        .orderBy(desc(orders.created_at));

    return successResponse(results);
});
