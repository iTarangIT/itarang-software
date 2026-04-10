import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { couponCodes, couponBatches, accounts } from '@/lib/db/schema';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export async function GET(req: NextRequest) {
    try {
        await requireRole(['admin', 'ceo', 'business_head']);

        const url = new URL(req.url);
        const dealerId = url.searchParams.get('dealer_id');
        const status = url.searchParams.get('status');
        const batchId = url.searchParams.get('batch_id');
        const dateFrom = url.searchParams.get('date_from');
        const dateTo = url.searchParams.get('date_to');
        const format = url.searchParams.get('format') || 'json'; // json or csv

        // Build conditions
        const conditions = [];
        if (dealerId) conditions.push(eq(couponCodes.dealer_id, dealerId));
        if (status) conditions.push(eq(couponCodes.status, status));
        if (batchId) conditions.push(eq(couponCodes.batch_id, batchId));
        if (dateFrom) conditions.push(gte(couponCodes.created_at, new Date(dateFrom)));
        if (dateTo) conditions.push(lte(couponCodes.created_at, new Date(dateTo)));

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        // Summary stats
        const summaryRows = await db
            .select({
                status: couponCodes.status,
                count: sql<number>`count(*)::int`,
            })
            .from(couponCodes)
            .where(whereClause)
            .groupBy(couponCodes.status);

        const summary: Record<string, number> = {
            total: 0, available: 0, reserved: 0, used: 0, expired: 0, revoked: 0,
        };
        for (const row of summaryRows) {
            summary[row.status] = row.count;
            summary.total += row.count;
        }

        // By dealer breakdown
        const byDealer = await db
            .select({
                dealer_id: couponCodes.dealer_id,
                dealer_name: accounts.business_entity_name,
                total: sql<number>`count(*)::int`,
                used: sql<number>`count(*) FILTER (WHERE ${couponCodes.status} = 'used')::int`,
            })
            .from(couponCodes)
            .leftJoin(accounts, eq(couponCodes.dealer_id, accounts.id))
            .where(whereClause)
            .groupBy(couponCodes.dealer_id, accounts.business_entity_name);

        // By month breakdown
        const byMonth = await db
            .select({
                month: sql<string>`TO_CHAR(${couponCodes.used_at}, 'YYYY-MM')`,
                count: sql<number>`count(*)::int`,
            })
            .from(couponCodes)
            .where(and(eq(couponCodes.status, 'used'), ...(whereClause ? [whereClause] : [])))
            .groupBy(sql`TO_CHAR(${couponCodes.used_at}, 'YYYY-MM')`)
            .orderBy(sql`TO_CHAR(${couponCodes.used_at}, 'YYYY-MM')`);

        if (format === 'csv') {
            // Export detailed usage as CSV
            const usedCoupons = await db
                .select({
                    code: couponCodes.code,
                    dealer_id: couponCodes.dealer_id,
                    dealer_name: accounts.business_entity_name,
                    batch_id: couponCodes.batch_id,
                    status: couponCodes.status,
                    discount_value: couponCodes.discount_value,
                    reserved_for_lead_id: couponCodes.reserved_for_lead_id,
                    used_by_lead_id: couponCodes.used_by_lead_id,
                    used_at: couponCodes.used_at,
                    created_at: couponCodes.created_at,
                })
                .from(couponCodes)
                .leftJoin(accounts, eq(couponCodes.dealer_id, accounts.id))
                .where(whereClause)
                .orderBy(sql`${couponCodes.created_at} DESC`)
                .limit(10000);

            const headers = ['Coupon Code', 'Dealer', 'Batch', 'Value', 'Status', 'Lead ID', 'Used At', 'Created At'];
            const rows = usedCoupons.map(c => [
                c.code,
                c.dealer_name || c.dealer_id,
                c.batch_id || '',
                c.discount_value || '0',
                c.status,
                c.used_by_lead_id || c.reserved_for_lead_id || '',
                c.used_at ? new Date(c.used_at).toISOString() : '',
                c.created_at ? new Date(c.created_at).toISOString() : '',
            ]);

            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

            return new NextResponse(csv, {
                status: 200,
                headers: {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': `attachment; filename="coupon-usage-report.csv"`,
                },
            });
        }

        return NextResponse.json({
            success: true,
            data: {
                summary,
                byDealer,
                byMonth: byMonth.filter(m => m.month !== null),
            },
        });
    } catch (error) {
        console.error('[Coupon Reports] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
