import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { logCouponAction } from '@/lib/coupon-audit';

type RouteContext = {
    params: Promise<{ couponId: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head']);
        const { couponId } = await context.params;

        // Find coupon
        const couponRows = await db
            .select()
            .from(couponCodes)
            .where(eq(couponCodes.id, couponId))
            .limit(1);

        if (!couponRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Coupon not found' } }, { status: 404 });
        }

        const coupon = couponRows[0];

        if (coupon.status !== 'reserved') {
            return NextResponse.json({
                success: false,
                error: { message: `Cannot release coupon with status "${coupon.status}". Only reserved coupons can be released.` },
            }, { status: 400 });
        }

        // Unlink from lead
        if (coupon.reserved_for_lead_id) {
            await db.update(leads)
                .set({ coupon_code: null, coupon_status: null, updated_at: new Date() })
                .where(eq(leads.id, coupon.reserved_for_lead_id));
        }

        // Release coupon back to available
        await db.update(couponCodes)
            .set({
                status: 'available',
                reserved_at: null,
                reserved_by: null,
                reserved_for_lead_id: null,
            })
            .where(eq(couponCodes.id, couponId));

        // Audit log
        await logCouponAction({
            couponId,
            action: 'released',
            oldStatus: 'reserved',
            newStatus: 'available',
            leadId: coupon.reserved_for_lead_id,
            performedBy: user.id,
            notes: 'Manually released by admin',
        });

        return NextResponse.json({
            success: true,
            couponCode: coupon.code,
            newStatus: 'available',
            message: 'Coupon released and now available',
        });
    } catch (error) {
        console.error('[Admin Release Coupon] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
