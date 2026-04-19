import { db } from '@/lib/db';
import { products, productCategories } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['dealer', 'ceo', 'sales_manager']);
    const { searchParams } = new URL(req.url);
    const categorySlug = searchParams.get('category');

    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            sku: products.sku,
            asset_type: products.asset_type,
            voltage_v: products.voltage_v,
            capacity_ah: products.capacity_ah,
            warranty_months: products.warranty_months,
            is_serialized: products.is_serialized,
            status: products.status,
            category_id: products.category_id,
            asset_category: productCategories.name,
            category_slug: productCategories.slug,
        })
        .from(products)
        .innerJoin(productCategories, eq(products.category_id, productCategories.id))
        .where(
            categorySlug
                ? eq(productCategories.slug, categorySlug)
                : eq(products.is_active, true)
        );

    return successResponse(rows);
});
