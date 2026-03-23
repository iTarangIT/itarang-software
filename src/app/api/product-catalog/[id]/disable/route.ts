import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

export const POST = withErrorHandler(async (
    req: Request,
    { params }: { params: { id: string } }
) => {
    await requireRole(['inventory_manager', 'ceo']);

    const [product] = await db.update(products)
        .set({ status: 'disabled', is_active: false, updated_at: new Date() })
        .where(eq(products.id, params.id))
        .returning();

    if (!product) {
        throw new Error('Product not found');
    }

    return successResponse(product);
});
