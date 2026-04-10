import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponBatches, couponCodes, accounts } from '@/lib/db/schema';
import { eq, and, gte, lte, sql, ilike } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['admin', 'ceo', 'business_head']);

        const url = new URL(req.url);
        const dealerId = url.searchParams.get('dealer_id');
        const status = url.searchParams.get('status');
        const dateFrom = url.searchParams.get('date_from');
        const dateTo = url.searchParams.get('date_to');
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20')));
        const offset = (page - 1) * limit;

        // Build conditions
        const conditions = [];
        if (dealerId) conditions.push(eq(couponBatches.dealer_id, dealerId));
        if (status) conditions.push(eq(couponBatches.status, status));
        if (dateFrom) conditions.push(gte(couponBatches.created_at, new Date(dateFrom)));
        if (dateTo) conditions.push(lte(couponBatches.created_at, new Date(dateTo)));

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        // Get batches with dealer info
        const batches = await db
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
                created_at: couponBatches.created_at,
            })
            .from(couponBatches)
            .leftJoin(accounts, eq(couponBatches.dealer_id, accounts.id))
            .where(whereClause)
            .orderBy(sql`${couponBatches.created_at} DESC`)
            .limit(limit)
            .offset(offset);

        // Get stats per batch
        const batchIds = batches.map(b => b.id);
        let batchStats: Record<string, Record<string, number>> = {};

        if (batchIds.length > 0) {
            const stats = await db
                .select({
                    batch_id: couponCodes.batch_id,
                    status: couponCodes.status,
                    count: sql<number>`count(*)::int`,
                })
                .from(couponCodes)
                .where(sql`${couponCodes.batch_id} IN (${sql.join(batchIds.map(id => sql`${id}`), sql`, `)})`)
                .groupBy(couponCodes.batch_id, couponCodes.status);

            for (const row of stats) {
                if (!row.batch_id) continue;
                if (!batchStats[row.batch_id]) batchStats[row.batch_id] = {};
                batchStats[row.batch_id][row.status] = row.count;
            }
        }

        // Total count for pagination
        const totalRows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(couponBatches)
            .where(whereClause);
        const total = totalRows[0]?.count || 0;

        const data = batches.map(batch => ({
            ...batch,
            stats: {
                available: batchStats[batch.id]?.available || 0,
                reserved: batchStats[batch.id]?.reserved || 0,
                used: batchStats[batch.id]?.used || 0,
                expired: batchStats[batch.id]?.expired || 0,
                revoked: batchStats[batch.id]?.revoked || 0,
            },
        }));

        return NextResponse.json({
            success: true,
            data,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('[List Batches] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
