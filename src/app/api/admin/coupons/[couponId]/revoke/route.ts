import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { logCouponAction } from '@/lib/coupon-audit';
import { z } from 'zod';

const revokeSchema = z.object({
    reason: z.string().min(1, 'Reason is required'),
    notes: z.string().optional(),
});

type RouteContext = {
    params: Promise<{ couponId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head']);
        const { couponId } = await context.params;
        const body = await req.json();

        const parsed = revokeSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json({
                success: false,
                error: { message: 'Validation failed', details: parsed.error.issues },
            }, { status: 400 });
        }

        const { reason, notes } = parsed.data;

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

        if (!['available', 'reserved'].includes(coupon.status)) {
            return NextResponse.json({
                success: false,
                error: { message: `Cannot revoke coupon with status "${coupon.status}". Only available or reserved coupons can be revoked.` },
            }, { status: 400 });
        }

        const oldStatus = coupon.status;

        // If reserved, unlink from lead
        if (coupon.status === 'reserved' && coupon.reserved_for_lead_id) {
            await db.update(leads)
                .set({ coupon_code: null, coupon_status: null, updated_at: new Date() })
                .where(eq(leads.id, coupon.reserved_for_lead_id));
        }

        // Revoke coupon
        await db.update(couponCodes)
            .set({
                status: 'revoked',
                reserved_at: null,
                reserved_by: null,
                reserved_for_lead_id: null,
            })
            .where(eq(couponCodes.id, couponId));

        // Audit log
        await logCouponAction({
            couponId,
            action: 'revoked',
            oldStatus,
            newStatus: 'revoked',
            leadId: coupon.reserved_for_lead_id,
            performedBy: user.id,
            notes: `${reason}${notes ? ` - ${notes}` : ''}`,
        });

        return NextResponse.json({
            success: true,
            message: 'Coupon revoked successfully',
        });
    } catch (error) {
        console.error('[Revoke Coupon] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
