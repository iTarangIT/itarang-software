import { db } from "@/lib/db";
import {
  accounts,
  inventory,
  inventoryUploadReports,
  paraphernaliaStock,
  products,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler, generateId } from "@/lib/api-utils";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { formatZodErrors, getRowSchema } from "@/lib/inventory/validation";
import { notifyInventoryAssigned } from "@/lib/notifications";
import { logInventoryEvent } from "@/lib/inventory/events";
import { resolveProductMaster } from "@/lib/inventory/product-master";

const bodySchema = z.object({
  dealerId: z.string().min(1),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  data: z.record(z.string(), z.any()),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = bodySchema.parse(await req.json());
  const { dealerId, assetType, data } = body as {
    dealerId: string;
    assetType: AssetType;
    data: Record<string, unknown>;
  };

  if (!ASSET_TYPES.includes(assetType)) {
    return errorResponse("Invalid assetType", 400);
  }

  const [dealer] = await db
    .select({ id: accounts.id, status: accounts.status })
    .from(accounts)
    .where(eq(accounts.id, dealerId))
    .limit(1);
  if (!dealer || dealer.status !== "active") {
    return errorResponse(`Dealer '${dealerId}' not found or inactive`, 400);
  }

  const schema = getRowSchema(assetType);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return errorResponse(formatZodErrors(parsed.error).join("; "), 400);
  }
  const row = parsed.data as Record<string, unknown>;

  // ── Resolve Product Master via the model_id / item_type_code handshake ───
  const masterKey =
    assetType === "paraphernalia"
      ? String(row.item_type_code || "").trim()
      : String(row.model_id || "").trim();

  if (!masterKey) {
    return errorResponse(
      assetType === "paraphernalia"
        ? "item_type_code is required"
        : "model_id is required",
      400,
    );
  }

  const resolved =
    assetType === "battery"
      ? await resolveProductMaster("battery", masterKey)
      : assetType === "charger"
        ? await resolveProductMaster("charger", masterKey)
        : await resolveProductMaster("paraphernalia", masterKey);

  if (!resolved.ok) {
    const label = assetType === "paraphernalia" ? "Item Type Code" : "Model ID";
    return errorResponse(
      resolved.reason === "NOT_FOUND"
        ? `${label} '${masterKey}' is not in Product Master.`
        : `${label} '${masterKey}' is inactive in Product Master.`,
      400,
    );
  }

  const master = resolved.master;
  const category = String(row.category || "").trim();

  // Battery / paraphernalia: enforce that the chosen category is in the
  // master's compatible_categories. Charger has no compatible_categories on
  // the master itself.
  if (master.kind === "battery" || master.kind === "paraphernalia") {
    const compat = master.compatibleCategories.map((c) => c.toLowerCase());
    if (compat.length && !compat.includes(category.toLowerCase())) {
      return errorResponse(
        `Category '${category}' is not compatible with ${masterKey}. Compatible: ${master.compatibleCategories.join(", ")}.`,
        400,
      );
    }
  }

  // Battery: enforce IoT compatibility — admin cannot mark iot_enabled when
  // the underlying battery model isn't IoT-capable.
  if (master.kind === "battery" && row.iot_enabled === true && !master.iotCompatible) {
    return errorResponse(
      `Battery model '${masterKey}' is not IoT-compatible. IoT Enabled cannot be set to Yes.`,
      400,
    );
  }

  const serial =
    assetType === "battery"
      ? String(row.battery_id || "").trim()
      : assetType === "charger"
        ? String(row.serial_number || "").trim()
        : "";
  if (serial) {
    const [dup] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.serial_number, serial))
      .limit(1);
    if (dup)
      return errorResponse(
        `Serial number / Battery ID must be unique — '${serial}' already exists.`,
        409,
      );
  }

  const imei = assetType === "battery" ? String(row.imei_id || "").trim() : "";
  if (imei) {
    const [dupImei] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.iot_imei_no, imei))
      .limit(1);
    if (dupImei) return errorResponse(`IMEI ${imei} already exists`, 409);
  }

  // Legacy products.sku lookup is preserved for back-compat with downstream
  // flows that filter by inventory.product_id (e.g. lead → product selection).
  const [product] = masterKey
    ? await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.sku, masterKey))
        .limit(1)
    : [];

  const now = new Date();
  const inventoryId = await generateId("INV");
  const reportId = await generateId("UPL");

  await db.transaction(async (tx) => {
    if (assetType === "battery" && master.kind === "battery") {
      const soldDate = new Date(String(row.sold_date));
      const warrantyDate = new Date(String(row.oem_warranty_date));
      const oemWarrantyMonths = Number(row.oem_warranty_months);
      const expiry = new Date(warrantyDate);
      expiry.setMonth(expiry.getMonth() + oemWarrantyMonths);
      const value = Number(row.invoice_value);
      const gstPercent = row.gst_percent != null ? Number(row.gst_percent) : 0;
      const gstAmount = value * (gstPercent / 100);
      const finalAmount = value + gstAmount;

      // Hydrated from product master:
      const subCategory = master.compatibleSubCategories[0] ?? "";
      const voltageV = master.voltageV ?? "";
      const capacityAh = master.capacityAh ?? "";
      const customerWarrantyMonths = master.warrantyMonths;
      // IoT — for non-IoT-capable masters, force false / clear IMEI.
      const iotEnabled = master.iotCompatible ? Boolean(row.iot_enabled) : false;
      const iotImei = iotEnabled ? imei || null : null;

      await tx.insert(inventory).values({
        id: inventoryId,
        inventory_type: "battery",
        serial_number: serial,
        iot_imei_no: iotImei,
        iot_enabled: iotEnabled,
        material_code: String(row.material_code || ""),
        asset_category: category,
        asset_type: "battery",
        sub_category: subCategory,
        model_type: master.modelId,
        product_id: product?.id ?? null,
        voltage_v: voltageV ? String(voltageV) : null,
        capacity_ah: capacityAh ? String(capacityAh) : null,
        star_rating: Number(row.star_rating),
        hsn_code: row.hsn_code ? String(row.hsn_code).trim().slice(0, 8) : null,
        warranty_months: customerWarrantyMonths,
        gst_percent: gstPercent ? gstPercent.toFixed(2) : null,
        gst_amount: gstPercent ? gstAmount.toFixed(2) : null,
        oem_invoice_number: String(row.invoice_number || ""),
        oem_invoice_date: soldDate,
        inventory_amount: value.toString(),
        final_amount: finalAmount.toFixed(2),
        oem_name: String(row.supplier_name || ""),
        oem_warranty_date: warrantyDate.toISOString().slice(0, 10),
        oem_warranty_months: oemWarrantyMonths,
        oem_warranty_expiry: expiry.toISOString().slice(0, 10),
        oem_warranty_clauses: row.oem_warranty_clauses ? String(row.oem_warranty_clauses) : null,
        batch_number: row.batch_reference ? String(row.batch_reference) : null,
        physical_condition: String(row.physical_condition || "").toLowerCase(),
        warehouse_location: row.warehouse_location ? String(row.warehouse_location) : null,
        is_serialized: true,
        status: "available",
        dealer_id: dealerId,
        allocated_to_dealer_at: now,
        created_by: user.id,
        upload_event_id: reportId,
        created_at: now,
        updated_at: now,
      });
    } else if (assetType === "charger" && master.kind === "charger") {
      const invoiceDate = new Date(String(row.invoice_date));
      const value = Number(row.invoice_value);
      const gstPercent = row.gst_percent != null ? Number(row.gst_percent) : 0;
      const gstAmount = value * (gstPercent / 100);
      const finalAmount = value + gstAmount;

      // Hydrated from product master:
      const outputVoltage = master.outputVoltageV ?? "";
      const outputCurrent = master.outputCurrentA ?? "";
      const compatibleBatteries = master.compatibleBatteryModels;
      const customerWarrantyMonths = master.warrantyMonths;

      await tx.insert(inventory).values({
        id: inventoryId,
        inventory_type: "charger",
        serial_number: serial,
        iot_enabled: false,
        asset_category: category,
        asset_type: "charger",
        sub_category: master.modelName,
        model_type: master.modelId,
        compatible_models: compatibleBatteries,
        output_current_a: outputCurrent ? String(outputCurrent) : null,
        voltage_v: outputVoltage ? String(outputVoltage) : null,
        product_id: product?.id ?? null,
        hsn_code: row.hsn_code ? String(row.hsn_code).trim().slice(0, 8) : null,
        warranty_months: customerWarrantyMonths,
        gst_percent: gstPercent ? gstPercent.toFixed(2) : null,
        gst_amount: gstPercent ? gstAmount.toFixed(2) : null,
        oem_invoice_number: String(row.invoice_number || ""),
        oem_invoice_date: invoiceDate,
        inventory_amount: value.toString(),
        final_amount: finalAmount.toFixed(2),
        oem_name: String(row.supplier_name || ""),
        physical_condition: String(row.physical_condition || "").toLowerCase(),
        warehouse_location: row.warehouse_location ? String(row.warehouse_location) : null,
        is_serialized: true,
        status: "available",
        dealer_id: dealerId,
        allocated_to_dealer_at: now,
        created_by: user.id,
        upload_event_id: reportId,
        created_at: now,
        updated_at: now,
      });
    } else if (assetType === "paraphernalia" && master.kind === "paraphernalia") {
      const invoiceDate = new Date(String(row.invoice_date));
      const value = Number(row.unit_cost);
      const qty = Number(row.quantity);
      const itemType = master.itemTypeCode;
      const compatible = master.compatibleCategories;
      const label = master.displayLabel;

      await tx.insert(inventory).values({
        id: inventoryId,
        inventory_type: "paraphernalia_lot",
        serial_number: null,
        iot_enabled: false,
        asset_category: category,
        asset_type: itemType,
        sub_category: category,
        model_type: label,
        quantity: qty,
        oem_invoice_number: String(row.invoice_number || ""),
        oem_invoice_date: invoiceDate,
        inventory_amount: value.toString(),
        final_amount: value.toString(),
        oem_name: row.supplier ? String(row.supplier) : null,
        warehouse_location: row.warehouse_location ? String(row.warehouse_location) : null,
        is_serialized: false,
        status: "available",
        dealer_id: dealerId,
        allocated_to_dealer_at: now,
        created_by: user.id,
        upload_event_id: reportId,
        created_at: now,
        updated_at: now,
      });

      const [existing] = await tx
        .select()
        .from(paraphernaliaStock)
        .where(
          and(
            eq(paraphernaliaStock.dealer_id, dealerId),
            eq(paraphernaliaStock.item_type, itemType),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(paraphernaliaStock)
          .set({
            available_qty: existing.available_qty + qty,
            unit_cost: value.toString(),
            compatible_categories: compatible,
            item_label: label,
            last_upload_at: now,
            updated_at: now,
          })
          .where(eq(paraphernaliaStock.id, existing.id));
      } else {
        await tx.insert(paraphernaliaStock).values({
          id: await generateId("PARA"),
          dealer_id: dealerId,
          item_type: itemType,
          item_label: label,
          compatible_categories: compatible,
          available_qty: qty,
          reserved_qty: 0,
          sold_qty: 0,
          unit_cost: value.toString(),
          last_upload_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    }

    await tx.insert(inventoryUploadReports).values({
      id: reportId,
      dealer_id: dealerId,
      asset_type: assetType,
      inventory_type: assetType,
      upload_method: "manual",
      uploaded_by: user.id,
      uploaded_at: now,
      total_rows: 1,
      inserted_rows: 1,
      skipped_rows: 0,
      rows_imported: 1,
      rows_skipped: 0,
      errors_json: [],
      inserted_inventory_ids: [inventoryId],
      source: "manual",
      report_url: `/api/admin/inventory/upload-report/${reportId}`,
    });

    await logInventoryEvent({
      tx,
      serialNumber: serial || `${assetType}:${inventoryId}`,
      inventoryId,
      eventType: "uploaded",
      fromStatus: null,
      toStatus: "available",
      performedBy: user.id,
      notes: "Manual add item",
      metadata: { dealerId, assetType, modelId: masterKey },
      performedAt: now,
    });
  });

  await notifyInventoryAssigned({
    dealerId,
    assetType,
    count: 1,
    reportId,
  });

  return successResponse({ id: inventoryId, reportId });
});
