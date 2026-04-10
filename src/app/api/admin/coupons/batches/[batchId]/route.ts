import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponBatches, couponCodes, accounts } from '@/lib/db/schema';
import { eq, and, sql, ilike } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

type RouteContext = {
    params: Promise<{ batchId: string }>;
};

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        await requireRole(['admin', 'ceo', 'business_head']);
        const { batchId } = await context.params;

        const url = new URL(req.url);
        const statusFilter = url.searchParams.get('status');
        const search = url.searchParams.get('search');
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50')));
        const offset = (page - 1) * limit;

        // Get batch details
        const batchRows = await db
            .select({
                id: couponBatches.id,
                name: couponBatches.name,
                dealer_id: couponBatches.dealer_id,
                dealer_name: accounts.business_entity_name,
                prefix: couponBatches.prefix,
                coupon_value: couponBatches.coupon_value,
                total_quantity: couponBatches.total_quantity,
                expiry_date: couponBatches.expiry_date,
                status: couponBatches.status,
                created_by: couponBatches.created_by,
                created_at: couponBatches.created_at,
            })
            .from(couponBatches)
            .leftJoin(accounts, eq(couponBatches.dealer_id, accounts.id))
            .where(eq(couponBatches.id, batchId))
            .limit(1);

        if (!batchRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Batch not found' } }, { status: 404 });
        }

        const batch = batchRows[0];

        // Stats breakdown
        const stats = await db
            .select({
                status: couponCodes.status,
                count: sql<number>`count(*)::int`,
            })
            .from(couponCodes)
            .where(eq(couponCodes.batch_id, batchId))
            .groupBy(couponCodes.status);

        const statusCounts: Record<string, number> = {
            available: 0, reserved: 0, used: 0, expired: 0, revoked: 0,
        };
        let total = 0;
        for (const row of stats) {
            statusCounts[row.status] = row.count;
            total += row.count;
        }

        // Build coupon list conditions
        const conditions = [eq(couponCodes.batch_id, batchId)];
        if (statusFilter) conditions.push(eq(couponCodes.status, statusFilter));
        if (search) conditions.push(ilike(couponCodes.code, `%${search}%`));

        const coupons = await db
            .select({
                id: couponCodes.id,
                code: couponCodes.code,
                status: couponCodes.status,
                reserved_at: couponCodes.reserved_at,
                reserved_for_lead_id: couponCodes.reserved_for_lead_id,
                used_at: couponCodes.used_at,
                used_by_lead_id: couponCodes.used_by_lead_id,
                expires_at: couponCodes.expires_at,
            })
            .from(couponCodes)
            .where(and(...conditions))
            .orderBy(couponCodes.code)
            .limit(limit)
            .offset(offset);

        const couponTotal = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(couponCodes)
            .where(and(...conditions));

        return NextResponse.json({
            success: true,
            data: {
                batch,
                stats: statusCounts,
                totalCoupons: total,
                coupons,
                pagination: {
                    page,
                    limit,
                    total: couponTotal[0]?.count || 0,
                    totalPages: Math.ceil((couponTotal[0]?.count || 0) / limit),
                },
            },
        });
    } catch (error) {
        console.error('[Batch Detail] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
