import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponBatches, couponCodes } from '@/lib/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { logCouponActionsBulk } from '@/lib/coupon-audit';

type RouteContext = {
    params: Promise<{ batchId: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head']);
        const { batchId } = await context.params;

        // Verify batch exists
        const batchRows = await db
            .select({ id: couponBatches.id, name: couponBatches.name })
            .from(couponBatches)
            .where(eq(couponBatches.id, batchId))
            .limit(1);

        if (!batchRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Batch not found' } }, { status: 404 });
        }

        // Find coupons to expire
        const toExpire = await db
            .select({ id: couponCodes.id, status: couponCodes.status })
            .from(couponCodes)
            .where(and(
                eq(couponCodes.batch_id, batchId),
                inArray(couponCodes.status, ['available', 'reserved']),
            ));

        if (!toExpire.length) {
            return NextResponse.json({ success: true, expiredCount: 0, message: 'No coupons to expire' });
        }

        // Bulk expire
        await db.update(couponCodes)
            .set({ status: 'expired' })
            .where(and(
                eq(couponCodes.batch_id, batchId),
                inArray(couponCodes.status, ['available', 'reserved']),
            ));

        // Update batch status
        await db.update(couponBatches)
            .set({ status: 'expired', updated_at: new Date() })
            .where(eq(couponBatches.id, batchId));

        // Audit log
        await logCouponActionsBulk(toExpire.map(c => ({
            couponId: c.id,
            action: 'expired' as const,
            oldStatus: c.status,
            newStatus: 'expired',
            performedBy: user.id,
            notes: `Bulk expired by admin (batch ${batchId})`,
        })));

        return NextResponse.json({
            success: true,
            expiredCount: toExpire.length,
            message: `${toExpire.length} coupons expired successfully`,
        });
    } catch (error) {
        console.error('[Expire Batch] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
