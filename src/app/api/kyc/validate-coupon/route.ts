import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { guardApi } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest) {
    // ID 118: signed in, with a role that reaches this screen.
    const authGate = await guardApi(["dealer", "admin", "ceo", "business_head", "sales_head", "sales_manager", "sales_executive", "finance_controller"]);
    if (!authGate.ok) return authGate.response;
    try {
        const { couponCode, leadId } = await req.json();

        if (!couponCode) {
            return NextResponse.json({ valid: false, message: 'Coupon code is required' });
        }

        const coupons = await db.select()
            .from(couponCodes)
            .where(and(
                eq(couponCodes.code, couponCode),
                eq(couponCodes.status, 'available')
            ))
            .limit(1);

        if (!coupons.length) {
            return NextResponse.json({ valid: false, message: 'Invalid coupon or expired' });
        }

        const coupon = coupons[0];

        // Check expiry
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
            return NextResponse.json({ valid: false, message: 'Coupon has expired' });
        }

        // Mark as validated
        await db.update(couponCodes)
            .set({ status: 'validated', validated_at: new Date() })
            .where(eq(couponCodes.id, coupon.id));

        return NextResponse.json({
            valid: true,
            creditsAvailable: coupon.credits_available,
            message: 'Coupon validated successfully',
        });
    } catch (error) {
        return NextResponse.json({ valid: false, message: 'Server error' }, { status: 500 });
    }
}
