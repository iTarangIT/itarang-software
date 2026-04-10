import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponBatches, couponCodes } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

type RouteContext = {
    params: Promise<{ batchId: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
    try {
        await requireRole(['admin', 'ceo', 'business_head']);
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

        // Get available coupons
        const coupons = await db
            .select({
                code: couponCodes.code,
                status: couponCodes.status,
                discount_type: couponCodes.discount_type,
                discount_value: couponCodes.discount_value,
                expires_at: couponCodes.expires_at,
            })
            .from(couponCodes)
            .where(and(
                eq(couponCodes.batch_id, batchId),
                eq(couponCodes.status, 'available'),
            ))
            .orderBy(couponCodes.code);

        // Build CSV
        const headers = ['Coupon Code', 'Value', 'Status', 'Expiry Date'];
        const rows = coupons.map(c => [
            c.code,
            c.discount_value || '0',
            c.status,
            c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : 'No Expiry',
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(r => r.join(',')),
        ].join('\n');

        return new NextResponse(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${batchId}-available-coupons.csv"`,
            },
        });
    } catch (error) {
        console.error('[Download Coupons] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
