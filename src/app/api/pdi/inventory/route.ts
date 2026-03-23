
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { oemInventoryForPDI, inventory, products, oems, provisions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const provisionId = searchParams.get('provision_id');
        const oemId = searchParams.get('oem_id');
        const status = searchParams.get('status') || 'pending';

        let filters = [eq(oemInventoryForPDI.pdi_status, status as any)];

        if (provisionId) {
            filters.push(eq(oemInventoryForPDI.provision_id, provisionId));
        }

        if (oemId) {
            filters.push(eq(oemInventoryForPDI.oem_id, oemId));
        }

        const rows = await db.select({
            id: oemInventoryForPDI.id,
            serial_number: oemInventoryForPDI.serial_number,
            pdi_status: oemInventoryForPDI.pdi_status,
            product: {
                id: products.id,
                name: products.name,
                asset_type: products.asset_type,
            },
            oem: {
                id: oems.id,
                name: oems.business_entity_name,
            },
            provision: {
                id: provisions.id,
                expected_delivery: provisions.expected_delivery_date,
            }
        })
            .from(oemInventoryForPDI)
            .leftJoin(inventory, eq(oemInventoryForPDI.inventory_id, inventory.id))
            .leftJoin(products, eq(inventory.product_id, products.id))
            .leftJoin(oems, eq(oemInventoryForPDI.oem_id, oems.id))
            .leftJoin(provisions, eq(oemInventoryForPDI.provision_id, provisions.id))
            .where(and(...filters));

        return NextResponse.json(rows);
    } catch (error) {
        console.error('Error fetching PDI inventory:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
