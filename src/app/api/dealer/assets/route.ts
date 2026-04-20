import { db } from '@/lib/db';
import { deployedAssets } from '@/lib/db/schema';
import { eq, and, ilike, or, sql } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    const { searchParams } = new URL(req.url);

    const status = searchParams.get('status') || 'all';
    const payment = searchParams.get('payment') || 'all';
    const category = searchParams.get('category') || 'all';
    const search = searchParams.get('search') || '';

    let rows: any[];
    try {
        const conditions: any[] = [eq(deployedAssets.dealer_id, user.dealer_id!)];

        if (status !== 'all') {
            conditions.push(eq(deployedAssets.status, status));
        }
        if (payment !== 'all') {
            conditions.push(eq(deployedAssets.payment_type, payment));
        }
        if (category !== 'all') {
            conditions.push(eq(deployedAssets.asset_category, category));
        }
        if (search) {
            conditions.push(
                or(
                    ilike(deployedAssets.serial_number, `%${search}%`),
                    ilike(deployedAssets.customer_name, `%${search}%`)
                )
            );
        }

        rows = await db
            .select({
                id: deployedAssets.id,
                serial_number: deployedAssets.serial_number,
                asset_category: deployedAssets.asset_category,
                asset_type: deployedAssets.asset_type,
                model_type: deployedAssets.model_type,
                customer_name: deployedAssets.customer_name,
                customer_phone: deployedAssets.customer_phone,
                deployment_date: deployedAssets.deployment_date,
                deployment_location: deployedAssets.deployment_location,
                payment_type: deployedAssets.payment_type,
                payment_status: deployedAssets.payment_status,
                battery_health_percent: deployedAssets.battery_health_percent,
                last_soc: deployedAssets.last_soc,
                last_voltage: deployedAssets.last_voltage,
                warranty_status: deployedAssets.warranty_status,
                status: deployedAssets.status,
                qr_code_url: deployedAssets.qr_code_url,
                last_maintenance_at: deployedAssets.last_maintenance_at,
                next_maintenance_due: deployedAssets.next_maintenance_due,
            })
            .from(deployedAssets)
            .where(and(...conditions))
            .orderBy(sql`${deployedAssets.deployment_date} DESC`)
            .limit(100);
    } catch {
        // Table may not exist yet
        rows = [];
    }

    return successResponse(rows);
});
