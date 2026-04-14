import { z } from 'zod';
import { db } from '@/lib/db';
import { inventory, products, productCategories, oems } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler, generateId } from '@/lib/api-utils';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

// Zod Schema for validation
const inventoryRowSchema = z.object({
    hsn_code: z.string().regex(/^[0-9]{8}$/),
    oem_name: z.string().min(1, 'OEM Name is required'),
    inventory_amount: z.coerce.number().positive(),
    gst_percent: z.coerce.number().refine(v => [5, 18].includes(v)),

    // Identifiers
    serial_number: z.string().optional(),
    batch_number: z.string().optional(), // Added SOP 7.4
    is_serialized: z.string().transform(v => v.toLowerCase() === 'true' || v === '1'),
    iot_imei_no: z.string().optional(), // Added

    // Purchase details
    warranty_months: z.coerce.number().int().nonnegative(),
    quantity: z.coerce.number().int().positive().default(1),
    manufacturing_date: z.string().min(1, 'Manufacturing date is required'),
    expiry_date: z.string().min(1, 'Expiry date is required'),

    // Invoice / Challan
    oem_invoice_number: z.string().min(1, 'OEM invoice number is required'),
    oem_invoice_date: z.string().min(1, 'OEM invoice date is required'),
    oem_invoice_url: z.string().optional(), // Added SOP 7.4
    challan_number: z.string().optional(),
    challan_date: z.string().optional(),

    // Location / Docs
    warehouse_location: z.string().optional(), // Added SOP 7.4
    product_manual_url: z.string().optional(), // Added SOP 7.4
    warranty_document_url: z.string().optional(), // Added SOP 7.4
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
        throw new Error('No file uploaded');
    }

    const buffer = await file.arrayBuffer();
    let rows: any[] = [];

    if (file.name.endsWith('.csv')) {
        const text = new TextDecoder().decode(buffer);
        rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
    } else {
        const workbook = XLSX.read(buffer);
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    }

    const results = { success: [] as any[], errors: [] as any[] };

    for (let i = 0; i < rows.length; i++) {
        try {
            const row = rows[i];
            const validated = inventoryRowSchema.parse(row);

            // 1. Find OEM
            let oem = await db.query.oems.findFirst({
                where: eq(oems.business_entity_name, validated.oem_name)
            });
            if (!oem) {
                // Try fuzzy match or just fail? Fail for now as per strict guidelines
                throw new Error(`OEM '${validated.oem_name}' not found. Please register OEM first.`);
            }

            // 2. Find Product by HSN code (join with category for asset_category)
            const productRow = await db
                .select({
                    id: products.id,
                    name: products.name,
                    sku: products.sku,
                    hsn_code: products.hsn_code,
                    asset_type: products.asset_type,
                    is_serialized: products.is_serialized,
                    warranty_months: products.warranty_months,
                    asset_category: productCategories.name,
                })
                .from(products)
                .innerJoin(productCategories, eq(products.category_id, productCategories.id))
                .where(eq(products.hsn_code, validated.hsn_code))
                .limit(1);

            const product = productRow[0];
            if (!product) throw new Error(`Product with HSN ${validated.hsn_code} not found in catalog`);

            // 3. Conditional Validations

            // Serialized items must have serial number
            if (validated.is_serialized && !validated.serial_number) {
                throw new Error('Serial number required for serialized items');
            }

            // IoT items must have IMEI
            if (product.name.includes('With IOT') && !validated.iot_imei_no) {
                throw new Error('IMEI number required for IoT enabled products');
            }

            // Calculate amounts
            const gst_amount = validated.inventory_amount * (validated.gst_percent / 100);
            const final_amount = validated.inventory_amount + gst_amount;

            // 4. Insert
            const [created] = await db.insert(inventory).values({
                id: await generateId('INV', inventory),
                product_id: product.id,
                oem_id: oem.id,

                // Denormalized Fields (SOP 7.4)
                oem_name: oem.business_entity_name,
                asset_category: product.asset_category,
                asset_type: product.asset_type ?? '',
                model_type: product.name,

                serial_number: validated.serial_number,
                batch_number: validated.batch_number,
                is_serialized: validated.is_serialized,
                iot_imei_no: validated.iot_imei_no,

                quantity: validated.quantity,
                manufacturing_date: new Date(validated.manufacturing_date),
                expiry_date: new Date(validated.expiry_date),

                oem_invoice_number: validated.oem_invoice_number,
                oem_invoice_date: new Date(validated.oem_invoice_date),
                oem_invoice_url: validated.oem_invoice_url,

                warehouse_location: validated.warehouse_location,
                product_manual_url: validated.product_manual_url,
                warranty_document_url: validated.warranty_document_url,

                inventory_amount: validated.inventory_amount.toString(),
                gst_percent: validated.gst_percent.toString(),
                gst_amount: gst_amount.toString(),
                final_amount: final_amount.toString(),

                status: 'available',
                created_by: user.id,
            }).returning();

            results.success.push({ row: i + 2, id: created.id });
        } catch (error: any) {
            results.errors.push({ row: i + 2, error: error.message });
        }
    }

    return successResponse(results);
});
