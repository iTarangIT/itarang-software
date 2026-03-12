import { db } from '@/lib/db';
import { orders, accounts, orderDisputes } from '@/lib/db/schema';
import { eq, and, or, lt } from 'drizzle-orm';

/**
 * Checks if an account is blocked from new orders based on SOP 3.6
 * Reasons:
 * 1. Has any "unpaid" order beyond credit term (Overdue)
 * 2. Total outstanding exceeds potential limits (If implemented, though SOP focuses on status)
 * 3. Has any "Partial" payment older than 30 days
 */
export async function checkCreditBlock(accountId: string) {
    const now = new Date();

    // Fetch Unpaid/Partial Orders for this account
    const unpaidOrders = await db.select()
        .from(orders)
        .where(
            and(
                eq(orders.account_id, accountId),
                or(
                    eq(orders.payment_status, 'unpaid'),
                    eq(orders.payment_status, 'partial')
                )
            )
        );

    for (const order of unpaidOrders) {
        // Simple logic: If order is older than 30 days and still unpaid -> Block
        const createdAt = new Date(order.created_at);
        const diffDays = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays > 30) {
            return {
                isBlocked: true,
                reason: `Account has overdue order: ${order.id} (${diffDays} days old)`,
                orderId: order.id
            };
        }
    }

    return { isBlocked: false };
}

/**
 * Checks if order fulfillment is blocked by an open dispute (SOP 9.6)
 */
export async function checkOrderFulfillmentBlock(orderId: string) {
    const [openDispute] = await db.select()
        .from(orderDisputes)
        .where(
            and(
                eq(orderDisputes.order_id, orderId),
                eq(orderDisputes.resolution_status, 'open')
            )
        )
        .limit(1);

    if (openDispute) {
        return {
            isBlocked: true,
            reason: `Order is locked due to open dispute: ${openDispute.id}`,
            disputeId: openDispute.id
        };
    }

    return { isBlocked: false };
}

/**
 * Calculates Reorder TAT for an account (SOP 3.6)
 */
export async function updateReorderTat(accountId: string, currentOrderId: string) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account || !account.last_order_fulfilled_at) {
        // First order or no previous tracking
        await db.update(accounts).set({ last_order_fulfilled_at: new Date() }).where(eq(accounts.id, accountId));
        return null;
    }

    const lastDate = new Date(account.last_order_fulfilled_at);
    const now = new Date();
    const tatDays = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    // Update the current order with this TAT
    await db.update(orders).set({ reorder_tat_days: tatDays }).where(eq(orders.id, currentOrderId));

    // Update account for next cycle
    await db.update(accounts).set({ last_order_fulfilled_at: now }).where(eq(accounts.id, accountId));

    return tatDays;
}
