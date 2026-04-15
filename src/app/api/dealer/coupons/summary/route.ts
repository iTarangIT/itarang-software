import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export async function GET() {
    try {
        const user = await requireRole(['dealer']);
        const dealerId = user.dealer_id;

        if (!dealerId) {
            return NextResponse.json({ success: false, error: { message: 'Dealer account not found' } }, { status: 403 });
        }

        // Count coupons by status
        const rows = await db
            .select({
                status: couponCodes.status,
                count: sql<number>`count(*)::int`,
            })
            .from(couponCodes)
            .where(eq(couponCodes.dealer_id, dealerId))
            .groupBy(couponCodes.status);

        const counts: Record<string, number> = {
            available: 0,
            reserved: 0,
            used: 0,
            expired: 0,
            revoked: 0,
        };

        for (const row of rows) {
            counts[row.status] = row.count;
        }
        const total = counts.available + counts.reserved + counts.used;

        return NextResponse.json({
            success: true,
            data: {
                ...counts,
                total,
                lowStockAlert: counts.available < 10,
            },
        });
    } catch (error) {
        console.error('[Coupon Summary] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
