import { db } from "@/lib/db";
import {
  inventory,
  inventoryUploadReports,
  oems,
  productCategories,
  products,
  accounts,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler, generateId } from "@/lib/api-utils";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { getRowSchema, formatZodErrors } from "@/lib/inventory/validation";
import { notifyInventoryAssigned } from "@/lib/notifications";

// Step 2 of the bulk-upload flow: takes the validated rows from /validate,
// re-runs the schema for safety, and inserts only error-free rows in a single
// transaction. Writes a single inventory_upload_reports audit row.

const bodySchema = z.object({
  dealerId: z.string().min(1, "dealerId required"),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  rows: z.array(z.record(z.string(), z.any())).min(1, "rows required"),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = bodySchema.parse(await req.json());
  const { dealerId, assetType, rows } = body as {
    dealerId: string;
    assetType: AssetType;
    rows: Record<string, unknown>[];
  };

  if (!ASSET_TYPES.includes(assetType))
    return errorResponse("Invalid assetType", 400);

  // Confirm dealer exists
  const dealerRow = await db
    .select({ id: accounts.id, name: accounts.business_entity_name })
    .from(accounts)
    .where(eq(accounts.id, dealerId))
    .limit(1);
  if (!dealerRow[0]) return errorResponse(`Dealer ${dealerId} not found`, 404);

  const schema = getRowSchema(assetType);

  // Lookup OEMs and products in batch
  const oemNames = Array.from(
    new Set(rows.map((r) => String(r.oem_name || "").trim()).filter(Boolean)),
  );
  const oemRows = oemNames.length
    ? await db.select().from(oems).where(inArray(oems.business_entity_name, oemNames))
    : [];
  const oemMap = new Map(oemRows.map((o) => [o.business_entity_name, o]));

  const hsnCodes = Array.from(
    new Set(rows.map((r) => String(r.hsn_code || "").trim()).filter(Boolean)),
  );
  const productJoin = hsnCodes.length
    ? await db
        .select({
          id: products.id,
          name: products.name,
          hsn_code: products.hsn_code,
          asset_type: products.asset_type,
          is_serialized: products.is_serialized,
          warranty_months: products.warranty_months,
          asset_category: productCategories.name,
        })
        .from(products)
        .innerJoin(productCategories, eq(products.category_id, productCategories.id))
        .where(inArray(products.hsn_code, hsnCodes))
    : [];
  const productMap = new Map(productJoin.map((p) => [p.hsn_code, p]));

  // Re-check dup serials against inventory table
  const incomingSerials = rows
    .map((r) => String(r.serial_number || "").trim())
    .filter(Boolean);
  const existing = incomingSerials.length
    ? await db
        .select({ serial_number: inventory.serial_number })
        .from(inventory)
        .where(inArray(inventory.serial_number, incomingSerials))
    : [];
  const existingSet = new Set(
    existing.map((r) => r.serial_number).filter((s): s is string => !!s),
  );

  const errors: { row: number; error: string }[] = [];
  const inserted: string[] = [];
  const seenInBatch = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    try {
      const parsed = schema.safeParse(rows[i]);
      if (!parsed.success) {
        errors.push({ row: rowNumber, error: formatZodErrors(parsed.error).join("; ") });
        continue;
      }
      const data = parsed.data as Record<string, unknown>;

      const oem = oemMap.get(String(data.oem_name));
      if (!oem) {
        errors.push({ row: rowNumber, error: `OEM '${data.oem_name}' not registered` });
        continue;
      }

      const product = productMap.get(String(data.hsn_code));
      if (!product) {
        errors.push({ row: rowNumber, error: `No catalog product for HSN ${data.hsn_code}` });
        continue;
      }

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
        if (existingSet.has(serial)) {
          errors.push({ row: rowNumber, error: `Serial ${serial} already exists` });
          continue;
        }
        if (seenInBatch.has(serial)) {
          errors.push({ row: rowNumber, error: `Serial ${serial} duplicated in batch` });
          continue;
        }
        seenInBatch.add(serial);
        existingSet.add(serial); // prevent re-insert in same loop
      }

      const inventoryAmount = Number(data.inventory_amount);
      const gstPercent = Number(data.gst_percent);
      const gstAmount = +(inventoryAmount * (gstPercent / 100)).toFixed(2);
      const finalAmount = +(inventoryAmount + gstAmount).toFixed(2);

      const newId = await generateId("INV");

      await db.insert(inventory).values({
        id: newId,
        oem_id: oem.id,
        oem_name: oem.business_entity_name,
        product_catalog_id: null,
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

      inserted.push(newId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      errors.push({ row: rowNumber, error: msg });
    }
  }

  // Persist audit row
  const reportId = `UPL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${dealerId.slice(-6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  await db.insert(inventoryUploadReports).values({
    id: reportId,
    dealer_id: dealerId,
    asset_type: assetType,
    uploaded_by: user.id,
    total_rows: rows.length,
    inserted_rows: inserted.length,
    skipped_rows: errors.length,
    errors_json: errors,
    inserted_inventory_ids: inserted,
    source: "bulk",
  });

  if (inserted.length > 0) {
    await notifyInventoryAssigned({
      dealerId,
      assetType,
      count: inserted.length,
      reportId,
    });
  }

  return successResponse({
    reportId,
    inserted: inserted.length,
    skipped: errors.length,
    errors,
    insertedIds: inserted,
  });
});
