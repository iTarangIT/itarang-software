import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, leads } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { logCouponAction } from '@/lib/coupon-audit';
import { z } from 'zod';

const cancelSchema = z.object({
    couponAction: z.enum(['release', 'consume']),
    notes: z.string().optional(),
});

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head']);
        const { leadId } = await context.params;
        const body = await req.json();

        const parsed = cancelSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json({
                success: false,
                error: { message: 'Validation failed', details: parsed.error.issues },
            }, { status: 400 });
        }

        const { couponAction, notes } = parsed.data;

        // Get lead with coupon info
        const leadRows = await db
            .select({
                id: leads.id,
                coupon_code: leads.coupon_code,
                coupon_status: leads.coupon_status,
            })
            .from(leads)
            .where(eq(leads.id, leadId))
            .limit(1);

        if (!leadRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        const lead = leadRows[0];

        if (!lead.coupon_code) {
            return NextResponse.json({ success: false, error: { message: 'No coupon associated with this lead' } }, { status: 400 });
        }

        // Find the coupon
        const couponRows = await db
            .select()
            .from(couponCodes)
            .where(eq(couponCodes.code, lead.coupon_code))
            .limit(1);

        if (!couponRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Coupon not found' } }, { status: 404 });
        }

        const coupon = couponRows[0];
        const oldStatus = coupon.status;
        const now = new Date();

        if (couponAction === 'release') {
            // Release coupon back to available pool
            await db.update(couponCodes)
                .set({
                    status: 'available',
                    reserved_at: null,
                    reserved_by: null,
                    reserved_for_lead_id: null,
                    used_by_lead_id: null,
                    used_by: null,
                    used_at: null,
                })
                .where(eq(couponCodes.id, coupon.id));

            // Clear lead coupon fields
            await db.update(leads)
                .set({ coupon_code: null, coupon_status: null, updated_at: now })
                .where(eq(leads.id, leadId));

            await logCouponAction({
                couponId: coupon.id,
                action: 'released',
                oldStatus,
                newStatus: 'available',
                leadId,
                performedBy: user.id,
                notes: notes || 'Verification cancelled by admin - coupon released',
            });

            return NextResponse.json({
                success: true,
                message: 'Verification cancelled. Coupon released back to dealer.',
            });
        } else {
            // Consume coupon (mark as used even though verification cancelled)
            await db.update(couponCodes)
                .set({
                    status: 'used',
                    used_at: now,
                    used_by: user.id,
                    used_by_lead_id: leadId,
                })
                .where(eq(couponCodes.id, coupon.id));

            await db.update(leads)
                .set({ coupon_status: 'used', updated_at: now })
                .where(eq(leads.id, leadId));

            await logCouponAction({
                couponId: coupon.id,
                action: 'used',
                oldStatus,
                newStatus: 'used',
                leadId,
                performedBy: user.id,
                notes: notes || 'Verification cancelled by admin - coupon consumed',
            });

            return NextResponse.json({
                success: true,
                message: 'Verification cancelled. Coupon marked as used.',
            });
        }
    } catch (error) {
        console.error('[Cancel Verification] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
