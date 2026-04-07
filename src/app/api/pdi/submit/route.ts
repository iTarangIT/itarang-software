
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { pdiRecords, oemInventoryForPDI, inventory } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: Request) {
    try {
        const body = await request.json();

        // Validate required fields (basic validation)
        const {
            oem_inventory_id,
            provision_id,
            physical_condition,
            pdi_status,
            service_engineer_id,
            latitude,
            longitude,
            // New Fields
            iot_imei_no,
            capacity_ah,
            resistance_mohm,
            temperature_celsius,
            pdi_photos
        } = body;

        if (!oem_inventory_id || !provision_id || !pdi_status || !service_engineer_id) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        if (!latitude || !longitude) {
            return NextResponse.json({ error: 'GPS coordinates are mandatory' }, { status: 400 });
        }

        if (!iot_imei_no || !capacity_ah || !resistance_mohm || !temperature_celsius) {
            return NextResponse.json({ error: 'Mandatory battery Technical Specs (IMEI, Ah, Resistance, Temp) missing' }, { status: 400 });
        }

        // Generate ID for new record
        const id = `pdi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Transaction to insert PDI record and update inventory status
        await db.transaction(async (tx) => {
            await tx.insert(pdiRecords).values({
                id,
                ...body,
                inspected_at: new Date(),
            });

            // Update inventory PDI status
            await tx.update(oemInventoryForPDI)
                .set({ pdi_status: pdi_status, pdi_record_id: id })
                .where(eq(oemInventoryForPDI.id, oem_inventory_id));

            // CRITICAL: Update main Inventory status
            // Retrieve inventory_id from oemInventoryForPDI
            const oemInv = await tx.select({ inventory_id: oemInventoryForPDI.inventory_id })
                .from(oemInventoryForPDI)
                .where(eq(oemInventoryForPDI.id, oem_inventory_id))
                .limit(1);

            if (oemInv && oemInv.length > 0 && oemInv[0].inventory_id) {
                const newStatus = pdi_status === 'pass' ? 'available' : 'pdi_failed';
                await tx.update(inventory)
                    .set({ status: newStatus })
                    .where(eq(inventory.id, oemInv[0].inventory_id));
            }
        });

        return NextResponse.json({ success: true, id }, { status: 201 });

    } catch (error) {
        console.error('Error submitting PDI:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
