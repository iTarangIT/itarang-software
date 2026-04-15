import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { logCouponAction } from '@/lib/coupon-audit';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await context.params;

        // Verify lead exists and belongs to dealer
        const leadRows = await db.select({
            id: leads.id,
            dealer_id: leads.dealer_id,
            coupon_code: leads.coupon_code,
            coupon_status: leads.coupon_status,
        }).from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!leadRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        const lead = leadRows[0];

        if (lead.coupon_status !== 'reserved' || !lead.coupon_code) {
            return NextResponse.json({ success: false, error: { message: 'No reserved coupon to release' } });
        }

        // Find the reserved coupon
        const reservedCoupons = await db.select()
            .from(couponCodes)
            .where(and(
                eq(couponCodes.code, lead.coupon_code),
                eq(couponCodes.status, 'reserved'),
                eq(couponCodes.reserved_for_lead_id, leadId),
            ))
            .limit(1);

        if (reservedCoupons.length) {
            // Release coupon back to available
            await db.update(couponCodes)
                .set({
                    status: 'available',
                    reserved_at: null,
                    reserved_by: null,
                    reserved_for_lead_id: null,
                })
                .where(eq(couponCodes.id, reservedCoupons[0].id));

            // Audit log
            await logCouponAction({
                couponId: reservedCoupons[0].id,
                action: 'released',
                oldStatus: 'reserved',
                newStatus: 'available',
                leadId,
                performedBy: user.id,
                notes: 'Dealer changed coupon',
            });
        }

        // Clear lead coupon fields
        await db.update(leads)
            .set({
                coupon_code: null,
                coupon_status: null,
                updated_at: new Date(),
            })
            .where(eq(leads.id, leadId));

        return NextResponse.json({
            success: true,
            message: 'Coupon released. You can now enter a new code.',
        });
    } catch (error) {
        console.error('[Release Coupon] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
