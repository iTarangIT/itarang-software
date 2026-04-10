import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { calculateDiscount } from '@/lib/razorpay';
import { logCouponAction } from '@/lib/coupon-audit';

const BASE_FEE = Number(process.env.FACILITATION_FEE_BASE_AMOUNT) || 1500;

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await context.params;
        const { couponCode } = await req.json();

        if (!couponCode || typeof couponCode !== 'string' || !couponCode.trim()) {
            return NextResponse.json({ valid: false, message: 'Coupon code is required' });
        }

        const code = couponCode.toUpperCase().trim();

        // Verify lead exists
        const leadRows = await db.select({
            id: leads.id,
            dealer_id: leads.dealer_id,
            coupon_code: leads.coupon_code,
            coupon_status: leads.coupon_status,
        }).from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!leadRows.length) {
            return NextResponse.json({ valid: false, message: 'Lead not found' }, { status: 404 });
        }

        const lead = leadRows[0];

        // Check if lead already has a reserved coupon
        if (lead.coupon_status === 'reserved' && lead.coupon_code) {
            return NextResponse.json({
                valid: false,
                message: `This lead already has coupon ${lead.coupon_code} reserved. Release it first to use a different code.`,
            });
        }

        // Find coupon by code (any status first to give better error messages)
        const allCoupons = await db.select({
            id: couponCodes.id,
            code: couponCodes.code,
            dealer_id: couponCodes.dealer_id,
            status: couponCodes.status,
            discount_type: couponCodes.discount_type,
            discount_value: couponCodes.discount_value,
            max_discount_cap: couponCodes.max_discount_cap,
            min_amount: couponCodes.min_amount,
            expires_at: couponCodes.expires_at,
        }).from(couponCodes)
            .where(eq(couponCodes.code, code))
            .limit(1);

        if (!allCoupons.length) {
            return NextResponse.json({ valid: false, message: 'Coupon code not found' });
        }

        const coupon = allCoupons[0];

        // Dealer scoping: coupon must belong to this dealer
        if (coupon.dealer_id !== user.dealer_id) {
            return NextResponse.json({ valid: false, message: 'This coupon is not assigned to your dealership' });
        }

        // Check status
        if (coupon.status !== 'available') {
            if (coupon.status === 'reserved') return NextResponse.json({ valid: false, message: 'This coupon is already reserved for another lead' });
            if (coupon.status === 'used') return NextResponse.json({ valid: false, message: 'This coupon has already been used' });
            if (coupon.status === 'expired') return NextResponse.json({ valid: false, message: 'This coupon has expired' });
            if (coupon.status === 'revoked') return NextResponse.json({ valid: false, message: 'This coupon has been revoked' });
            return NextResponse.json({ valid: false, message: `Coupon is not available (status: ${coupon.status})` });
        }

        // Check expiry
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
            // Auto-expire
            await db.update(couponCodes).set({ status: 'expired' }).where(eq(couponCodes.id, coupon.id));
            return NextResponse.json({ valid: false, message: 'This coupon has expired' });
        }

        // Calculate discount
        const discountAmount = calculateDiscount(
            BASE_FEE,
            coupon.discount_type,
            coupon.discount_value ? Number(coupon.discount_value) : null,
            coupon.max_discount_cap ? Number(coupon.max_discount_cap) : null,
        );
        const finalAmount = BASE_FEE - discountAmount;

        const now = new Date();

        // Reserve the coupon
        await db.update(couponCodes)
            .set({
                status: 'reserved',
                reserved_at: now,
                reserved_by: user.id,
                reserved_for_lead_id: leadId,
            })
            .where(eq(couponCodes.id, coupon.id));

        // Update lead with coupon info
        await db.update(leads)
            .set({
                coupon_code: code,
                coupon_status: 'reserved',
                updated_at: now,
            })
            .where(eq(leads.id, leadId));

        // Audit log
        await logCouponAction({
            couponId: coupon.id,
            action: 'reserved',
            oldStatus: 'available',
            newStatus: 'reserved',
            leadId,
            performedBy: user.id,
            notes: `Reserved for Lead #${leadId}`,
        });

        return NextResponse.json({
            valid: true,
            success: true,
            coupon_id: coupon.id,
            coupon_code: coupon.code,
            discount_type: coupon.discount_type,
            discount_value: coupon.discount_value ? Number(coupon.discount_value) : 0,
            discount_amount: discountAmount,
            base_amount: BASE_FEE,
            final_amount: finalAmount,
            status: 'reserved',
            message: discountAmount > 0
                ? `Coupon applied! You save ₹${discountAmount}`
                : 'Coupon validated and reserved successfully',
        });
    } catch (error) {
        console.error('[Validate Coupon] Error:', error);
        return NextResponse.json({ valid: false, message: 'Server error' }, { status: 500 });
    }
}
