import { db } from '@/lib/db';
import { inventory, products } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireAuth();

    const { searchParams } = new URL(req.url);
    const filters: any[] = [];

    const assetCategory = searchParams.get('asset_category');
    if (assetCategory) {
        filters.push(eq(inventory.asset_category, assetCategory));
    }

    const statusParam = searchParams.get('status');
    if (statusParam) {
        filters.push(eq(inventory.status, statusParam));
    }

    // inventory has denormalized product fields; join products for hsn_code
    const results = await db.select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        status: inventory.status,
        inventory_amount: inventory.inventory_amount,
        gst_amount: inventory.gst_amount,
        final_amount: inventory.final_amount,
        created_at: inventory.created_at,
        product: {
            hsn_code: products.hsn_code,
            asset_category: inventory.asset_category,
            asset_type: inventory.asset_type,
            model_type: inventory.model_type,
        }
    })
        .from(inventory)
        .leftJoin(products, eq(inventory.product_id, products.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(inventory.created_at));

    return successResponse(results);
});
