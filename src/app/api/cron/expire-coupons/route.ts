import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes } from '@/lib/db/schema';
import { and, lt, inArray, sql } from 'drizzle-orm';
import { logCouponActionsBulk } from '@/lib/coupon-audit';

export async function GET() {
    try {
        const now = new Date();

        // Find all coupons past expiry date that are still available or reserved
        const toExpire = await db
            .select({
                id: couponCodes.id,
                code: couponCodes.code,
                status: couponCodes.status,
                dealer_id: couponCodes.dealer_id,
                reserved_for_lead_id: couponCodes.reserved_for_lead_id,
            })
            .from(couponCodes)
            .where(and(
                lt(couponCodes.expires_at, now),
                inArray(couponCodes.status, ['available', 'reserved']),
            ));

        if (!toExpire.length) {
            return NextResponse.json({
                success: true,
                expiredCount: 0,
                message: 'No coupons to expire',
            });
        }

        // Bulk update status
        const couponIds = toExpire.map(c => c.id);
        for (let i = 0; i < couponIds.length; i += 500) {
            const chunk = couponIds.slice(i, i + 500);
            await db.update(couponCodes)
                .set({ status: 'expired' })
                .where(inArray(couponCodes.id, chunk));
        }

        // Audit log
        await logCouponActionsBulk(toExpire.map(c => ({
            couponId: c.id,
            action: 'expired' as const,
            oldStatus: c.status,
            newStatus: 'expired',
            performedBy: null,
            notes: 'Auto-expired by system cron',
        })));

        // Log reserved coupons that were expired (dealers should be notified)
        const reservedExpired = toExpire.filter(c => c.status === 'reserved');
        if (reservedExpired.length > 0) {
            console.log(`[Expire Coupons] ${reservedExpired.length} reserved coupons were expired. Dealers affected:`,
                [...new Set(reservedExpired.map(c => c.dealer_id))]);
        }

        console.log(`[Expire Coupons] Expired ${toExpire.length} coupons`);

        return NextResponse.json({
            success: true,
            expiredCount: toExpire.length,
            reservedExpiredCount: reservedExpired.length,
            message: `Expired ${toExpire.length} coupons`,
        });
    } catch (error) {
        console.error('[Expire Coupons Cron] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
