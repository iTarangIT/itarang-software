import { db } from '@/lib/db';
import { productCategories } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async () => {
    await requireRole(['dealer', 'ceo', 'sales_manager']);

    const vehicleCategorySlugs = ['2w', '3w', '4w', 'commercial'];

    const rows = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.is_active, true))
        .orderBy(asc(productCategories.name));

    const result = rows.map(c => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        isVehicleCategory: vehicleCategorySlugs.some(s => c.slug.startsWith(s)),
    }));

    return successResponse(result);
});
