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
 * Calculates Reorder TAT for an account (SOP 3.6).
 *
 * Disabled: depends on `accounts.last_order_fulfilled_at`, which does not
 * exist in the current Drizzle schema or in database-1 (sandbox). Adding the
 * column to the schema without first migrating the DB would break every other
 * `select().from(accounts)`. Restore once a migration adds the column on the
 * schema/sync-with-rds branch.
 */
export async function updateReorderTat(_accountId: string, _currentOrderId: string) {
    console.warn(
        "[sales-utils] updateReorderTat skipped: accounts.last_order_fulfilled_at not present in schema",
    );
    return null;
}
