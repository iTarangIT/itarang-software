import { db } from '@/lib/db';
import { inventory, products } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { errorResponse, successResponse, withErrorHandler } from '@/lib/api-utils';
import { inventoryListScope } from '@/lib/inventory/stockUploadRules';
import { ownDealerCodeOf } from '@/lib/inventory/stockUploadGuard';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();

    // ID 173: every dealer's stock and cost price — back office (and CEO) see
    // all, a dealer only its own account, anyone else is refused.
    const scope = inventoryListScope(user.role);
    if (scope === 'none') return errorResponse('Forbidden: you cannot view the stock list', 403);

    const { searchParams } = new URL(req.url);
    const filters: any[] = [];

    if (scope === 'own') {
        const own = await ownDealerCodeOf(user);
        if (!own) return errorResponse('Forbidden: no dealer account on this login', 403);
        filters.push(eq(inventory.dealer_id, own));
    }

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
