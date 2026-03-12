import { db } from '@/lib/db';
import { orders, approvals, inventory } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth-utils';
import OrderDetailsClient from './order-details-client';

interface PageProps {
    params: Promise<{ id: string }>;
}

export default async function OrderDetailsPage({ params }: PageProps) {
    const user = await requireAuth();
    const { id: orderId } = await params;

    // 1. Fetch Order
    const [order] = await db.select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);

    if (!order) notFound();

    // 2. Fetch Approvals for this order
    const orderApprovals = await db.select()
        .from(approvals)
        .where(eq(approvals.entity_id, orderId))
        .orderBy(desc(approvals.decision_at));

    // 3. Fetch Items Details (for serial numbers)
    const itemIds = (order.order_items as any[] || []).map(i => i.inventory_id);
    // Since itemIds is small, we can fetch the display details

    return (
        <div className="min-h-screen bg-brand-50/30 p-4 md:p-8">
            <OrderDetailsClient
                order={order}
                approvals={orderApprovals}
                userRole={user.role as any}
                userId={user.id}
            />
        </div>
    );
}
