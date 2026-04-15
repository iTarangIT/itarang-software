import { db } from '@/lib/db';
import { products, productCategories } from '@/lib/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['dealer', 'ceo', 'sales_manager']);
    const { searchParams } = new URL(req.url);
    const categorySlug = searchParams.get('category');

    const conditions = [eq(products.is_active, true)];
    if (categorySlug) {
        conditions.push(eq(productCategories.slug, categorySlug));
    }

    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            hsn_code: products.hsn_code,
            asset_type: products.asset_type,
            voltage_v: products.voltage_v,
            capacity_ah: products.capacity_ah,
            warranty_months: products.warranty_months,
            is_serialized: products.is_serialized,
            sort_order: products.sort_order,
            status: products.status,
            category_id: products.category_id,
            asset_category: productCategories.name,
            category_slug: productCategories.slug,
        })
        .from(products)
        .innerJoin(productCategories, eq(products.category_id, productCategories.id))
        .where(and(...conditions))
        .orderBy(asc(products.sort_order), asc(products.name));

    return successResponse(rows);
});
