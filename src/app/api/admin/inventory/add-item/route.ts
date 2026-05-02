import { db } from "@/lib/db";
import {
  inventory,
  inventoryUploadReports,
  oems,
  productCategories,
  products,
  accounts,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler, generateId } from "@/lib/api-utils";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { getRowSchema, formatZodErrors } from "@/lib/inventory/validation";
import { notifyInventoryAssigned } from "@/lib/notifications";

// Method B: admin adds a single inventory item via form. Same validation
// pipeline as bulk-upload but skips the preview step.

const bodySchema = z.object({
  dealerId: z.string().min(1),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  data: z.record(z.string(), z.any()),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = bodySchema.parse(await req.json());
  const { dealerId, assetType, data: rawData } = body as {
    dealerId: string;
    assetType: AssetType;
    data: Record<string, unknown>;
  };

  if (!ASSET_TYPES.includes(assetType))
    return errorResponse("Invalid assetType", 400);

  const dealer = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, dealerId))
    .limit(1);
  if (!dealer[0]) return errorResponse(`Dealer ${dealerId} not found`, 404);

  const schema = getRowSchema(assetType);
  const parsed = schema.safeParse(rawData);
  if (!parsed.success) {
    return errorResponse(formatZodErrors(parsed.error).join("; "), 400);
  }
  const data = parsed.data as Record<string, unknown>;

  const oem = await db
    .select()
    .from(oems)
    .where(eq(oems.business_entity_name, String(data.oem_name)))
    .limit(1);
  if (!oem[0]) return errorResponse(`OEM '${data.oem_name}' not registered`, 400);

  const productJoin = await db
    .select({
      id: products.id,
      name: products.name,
      asset_type: products.asset_type,
      warranty_months: products.warranty_months,
      asset_category: productCategories.name,
    })
    .from(products)
    .innerJoin(productCategories, eq(products.category_id, productCategories.id))
    .where(eq(products.hsn_code, String(data.hsn_code)))
    .limit(1);
  const product = productJoin[0];
  if (!product) return errorResponse(`No catalog product for HSN ${data.hsn_code}`, 400);

  let serial: string | null = null;
  let isSerialized = true;
  let quantity = 1;
  let modelType = product.name;
  let assetTypeValue = product.asset_type ?? assetType;

  if (assetType === "paraphernalia") {
    isSerialized = false;
    quantity = Number(data.quantity);
    assetTypeValue = String(data.asset_type);
    modelType = String(data.model_type);
  } else {
    serial = String(data.serial_number).trim();
    const dup = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.serial_number, serial))
      .limit(1);
    if (dup[0]) return errorResponse(`Serial ${serial} already exists`, 409);
  }

  const inventoryAmount = Number(data.inventory_amount);
  const gstPercent = Number(data.gst_percent);
  const gstAmount = +(inventoryAmount * (gstPercent / 100)).toFixed(2);
  const finalAmount = +(inventoryAmount + gstAmount).toFixed(2);

  const newId = await generateId("INV");

  await db.insert(inventory).values({
    id: newId,
    oem_id: oem[0].id,
    oem_name: oem[0].business_entity_name,
    product_id: product.id,
    hsn_code: String(data.hsn_code),
    asset_category: product.asset_category,
    asset_type: assetTypeValue,
    model_type: modelType,
    serial_number: serial,
    is_serialized: isSerialized,
    warranty_months: Number(data.warranty_months ?? product.warranty_months ?? 0),
    quantity,
    manufacturing_date: new Date(String(data.manufacturing_date)),
    expiry_date: new Date(String(data.expiry_date)),
    oem_invoice_number: String(data.oem_invoice_number),
    oem_invoice_date: new Date(String(data.oem_invoice_date)),
    warehouse_location: data.warehouse_location ? String(data.warehouse_location) : null,
    iot_imei_no: data.iot_imei_no ? String(data.iot_imei_no) : null,
    batch_number: data.batch_number ? String(data.batch_number) : null,
    inventory_amount: inventoryAmount.toString(),
    gst_percent: gstPercent.toString(),
    gst_amount: gstAmount.toString(),
    final_amount: finalAmount.toString(),
    status: "available",
    dealer_id: dealerId,
    allocated_to_dealer_at: new Date(),
    created_by: user.id,
  });

  // Audit single-item adds too
  const reportId = `UPL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${dealerId.slice(-6)}-S${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  await db.insert(inventoryUploadReports).values({
    id: reportId,
    dealer_id: dealerId,
    asset_type: assetType,
    uploaded_by: user.id,
    total_rows: 1,
    inserted_rows: 1,
    skipped_rows: 0,
    errors_json: [],
    inserted_inventory_ids: [newId],
    source: "manual",
  });

  await notifyInventoryAssigned({
    dealerId,
    assetType,
    count: 1,
    reportId,
  });

  return successResponse({ id: newId, reportId });
});
