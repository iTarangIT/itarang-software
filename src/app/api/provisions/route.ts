import { z } from 'zod';
import { db } from '@/lib/db';
import { provisions, oems } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';
import { triggerN8nWebhook } from '@/lib/n8n';

const provisionSchema = z.object({
    oem_id: z.string().min(1),
    expected_delivery_date: z.string().transform(v => new Date(v)),
    products: z.array(z.object({
        product_id: z.string().min(1),
        model_type: z.string(),
        quantity: z.number().positive(),
    })).min(1),
    remarks: z.string().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['inventory_manager', 'ceo', 'business_head']);
    const body = await req.json();
    const validated = provisionSchema.parse(body);

    // Get OEM name
    const [oem] = await db.select().from(oems).where(eq(oems.id, validated.oem_id)).limit(1);
    if (!oem) throw new Error('OEM not found');

    const provisionId = await generateId('PROV', provisions);

    const [newProvision] = await db.insert(provisions).values({
        id: provisionId,
        oem_id: validated.oem_id,
        oem_name: oem.business_entity_name,
        products: validated.products as any,
        expected_delivery_date: validated.expected_delivery_date,
        remarks: validated.remarks,
        status: 'pending',
        created_by: user.id,
    }).returning();

    // Trigger n8n webhook
    try {
        await triggerN8nWebhook('provision-created', {
            provision_id: provisionId,
            oem_name: oem.business_entity_name,
            products: validated.products,
            created_by_name: user.name
        });
    } catch (err) {
        console.error('Webhook failed:', err);
    }

    return successResponse(newProvision, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['inventory_manager', 'ceo', 'business_head', 'finance_controller', 'sales_head']);

    const results = await db.select()
        .from(provisions)
        .orderBy(desc(provisions.created_at));

    return successResponse(results);
});
