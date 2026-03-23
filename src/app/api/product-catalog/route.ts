import { z } from 'zod';
import { db } from '@/lib/db';
import { products, productCategories } from '@/lib/db/schema';
import { eq, asc, desc } from 'drizzle-orm';
import { requireAuth, requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { triggerN8nWebhook } from '@/lib/n8n';

const schema = z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    category_id: z.string().uuid(),
    hsn_code: z.string().optional(),
    asset_type: z.string().optional(),
    voltage_v: z.number().optional(),
    capacity_ah: z.number().optional(),
    sku: z.string().optional(),
    is_serialized: z.boolean().default(true),
    warranty_months: z.number().int().min(1).max(120).optional(),
    sort_order: z.number().int().default(0),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['inventory_manager', 'ceo']);
    const body = await req.json();
    const validated = schema.parse(body);

    const [product] = await db.insert(products).values({
        ...validated,
        status: 'active',
        is_active: true,
    }).returning();

    await triggerN8nWebhook('product-catalog-created', { product_id: product.id });

    return successResponse(product, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireAuth();

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');

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
            is_serialized: products.is_serialized,
            warranty_months: products.warranty_months,
            status: products.status,
            is_active: products.is_active,
            sort_order: products.sort_order,
            category_id: products.category_id,
            asset_category: productCategories.name,
            created_at: products.created_at,
        })
        .from(products)
        .innerJoin(productCategories, eq(products.category_id, productCategories.id))
        .where(status ? eq(products.status, status) : eq(products.is_active, true))
        .orderBy(desc(products.created_at));

    return successResponse(rows);
});
