import { db } from '@/lib/db';
import { provisions, oemInventoryForPDI, inventory } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireAuth();
    const { searchParams } = new URL(req.url);
    const provisionId = searchParams.get('provision_id');

    if (!provisionId) throw new Error('Provision ID is required');

    // 1. Get Provision
    const [provision] = await db.select()
        .from(provisions)
        .where(eq(provisions.id, provisionId))
        .limit(1);

    if (!provision) throw new Error('Provision not found');

    // 2. Get Inventory Items linked via oemInventoryForPDI
    const pdiItems = await db.select({
        inventory_id: oemInventoryForPDI.inventory_id
    })
        .from(oemInventoryForPDI)
        .where(eq(oemInventoryForPDI.provision_id, provisionId));

    const inventoryIds = pdiItems.map(i => i.inventory_id);

    let items: any[] = [];
    if (inventoryIds.length > 0) {
        // Since we can't use inArray with empty list and it might be many, we fetch them
        // For simplicity and matching the frontend expectations
        const allInventory = await db.select({
            id: inventory.id,
            serial_number: inventory.serial_number,
            model_type: inventory.model_type,
            final_amount: inventory.final_amount,
            status: inventory.status
        })
            .from(inventory)
            .where(eq(inventory.oem_id, provision.oem_id));

        // Filter by the ones associated with this provision's PDI requests
        items = allInventory.filter(i => inventoryIds.includes(i.id));
    }

    return successResponse({
        provision,
        items
    });
});
