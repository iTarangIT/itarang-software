import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { calculateDiscount } from '@/lib/razorpay';

const BASE_FEE = Number(process.env.FACILITATION_FEE_BASE_AMOUNT) || 1500;

// Master coupon — always valid, 100% discount, works for every lead and
// every dealer. Short-circuits the couponCodes table lookup so there is no
// stock to exhaust or expiry to worry about.
const HARDCODED_FREE_COUPON = 'ITARANG-FREE';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const { couponCode } = await req.json();

        if (!couponCode) {
            return NextResponse.json({ valid: false, message: 'Coupon code is required' });
        }

        // Verify lead exists
        const leadRows = await db.select({ id: leads.id, payment_method: leads.payment_method })
            .from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!leadRows.length) {
            return NextResponse.json({ valid: false, message: 'Lead not found' }, { status: 404 });
        }

        const normalizedCode = String(couponCode).toUpperCase().trim();

        // ── Hardcoded free coupon ─────────────────────────────────────────
        // Reserve it directly on the lead so page reload, release-coupon, and
        // the submit-for-verification checks all behave the same as with a
        // real DB-backed coupon.
        if (normalizedCode === HARDCODED_FREE_COUPON) {
            await db.update(leads)
                .set({
                    coupon_code: HARDCODED_FREE_COUPON,
                    coupon_status: 'reserved',
                    updated_at: new Date(),
                })
                .where(eq(leads.id, leadId));

            return NextResponse.json({
                valid: true,
                success: true,
                coupon_code: HARDCODED_FREE_COUPON,
                discount_type: 'percent',
                discount_value: 100,
                discount_amount: BASE_FEE,
                base_amount: BASE_FEE,
                final_amount: 0,
                message: 'Free verification coupon applied — no charge for this lead',
            });
        }

        // Find coupon
        const coupons = await db.select()
            .from(couponCodes)
            .where(and(
                eq(couponCodes.code, couponCode.toUpperCase().trim()),
                eq(couponCodes.status, 'available')
            ))
            .limit(1);

        if (!coupons.length) {
            return NextResponse.json({ valid: false, message: 'Invalid or already used coupon code' });
        }

        const coupon = coupons[0];

        // Check expiry
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
            return NextResponse.json({ valid: false, message: 'Coupon has expired' });
        }

        // Check minimum amount
        const minAmount = coupon.min_amount ? Number(coupon.min_amount) : 0;
        if (minAmount > BASE_FEE) {
            return NextResponse.json({ valid: false, message: `Minimum order amount is ₹${minAmount}` });
        }

        // Calculate discount
        const discountAmount = calculateDiscount(
            BASE_FEE,
            coupon.discount_type,
            coupon.discount_value ? Number(coupon.discount_value) : null,
            coupon.max_discount_cap ? Number(coupon.max_discount_cap) : null
        );

        const finalAmount = BASE_FEE - discountAmount;

        // Reserve this coupon on the lead so the Submit-for-Verification button
        // remains visible after a page reload (the UI reads lead.coupon_status).
        try {
            await db.update(leads)
                .set({
                    coupon_code: coupon.code,
                    coupon_status: 'reserved',
                    updated_at: new Date(),
                })
                .where(eq(leads.id, leadId));
        } catch (updateErr) {
            console.error('[Validate Coupon] Failed to reserve coupon on lead:', updateErr);
            return NextResponse.json({ valid: false, message: 'Coupon unavailable' });
        }

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
            message: discountAmount > 0
                ? `Coupon applied! You save ₹${discountAmount}`
                : 'Coupon validated successfully',
        });
    } catch (error) {
        console.error('[Validate Coupon] Error:', error);
        return NextResponse.json({ valid: false, message: 'Server error' }, { status: 500 });
    }
}
