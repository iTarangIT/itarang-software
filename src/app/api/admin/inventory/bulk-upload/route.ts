import { db } from "@/lib/db";
import {
  accounts,
  inventory,
  inventoryUploadReports,
  paraphernaliaStock,
  products,
} from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import {
  successResponse,
  errorResponse,
  withErrorHandler,
  generateId,
} from "@/lib/api-utils";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { formatZodErrors, getRowSchema } from "@/lib/inventory/validation";
import { notifyInventoryAssigned } from "@/lib/notifications";
import { logInventoryEvent } from "@/lib/inventory/events";
import {
  loadProductMasterBatch,
  type BatteryMaster,
  type ChargerMaster,
  type ParaphernaliaMaster,
} from "@/lib/inventory/product-master";

type StructuredError = {
  row: number;
  field: string;
  code: string;
  message: string;
};

function getPgCode(error: unknown): string | null {
  let curr: unknown = error;
  while (curr && typeof curr === "object") {
    const rec = curr as { code?: string; cause?: unknown };
    if (rec.code) return rec.code;
    curr = rec.cause;
  }
  return null;
}

function hasPgCode(error: unknown, code: string): boolean {
  return getPgCode(error) === code;
}

function safeDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Safe wrapper for inArray — Drizzle throws if the array is empty.
async function safeInArrayQuery<T>(
  arr: string[],
  queryFn: (arr: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (!arr.length) return [];
  return queryFn(arr);
}

function makeSavepoint(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9]/g, "_");
  const name = `sp_${sanitized}`;
  return name.slice(0, 63);
}

const bodySchema = z.object({
  dealerId: z.string().min(1, "dealerId required"),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  rows: z.array(z.record(z.string(), z.any())).min(1, "rows required"),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse("Invalid request body: " + String(err), 400);
  }

  const { dealerId, assetType, rows } = body as {
    dealerId: string;
    assetType: AssetType;
    rows: Record<string, unknown>[];
  };

  if (!ASSET_TYPES.includes(assetType)) {
    return errorResponse("Invalid assetType", 400);
  }

  const [dealer] = await db
    .select({
      id: accounts.id,
      status: accounts.status,
      name: accounts.business_entity_name,
    })
    .from(accounts)
    .where(eq(accounts.id, dealerId))
    .limit(1);

  if (!dealer || dealer.status !== "active") {
    return errorResponse(`Dealer '${dealerId}' not found or inactive`, 400);
  }

  const incomingSerials =
    assetType === "battery"
      ? rows.map((r) => String(r.battery_id || "").trim()).filter(Boolean)
      : assetType === "charger"
        ? rows.map((r) => String(r.serial_number || "").trim()).filter(Boolean)
        : [];

  const incomingImeis =
    assetType === "battery"
      ? rows.map((r) => String(r.imei_id || "").trim()).filter(Boolean)
      : [];

  const existingSerialRows = await safeInArrayQuery(
    incomingSerials,
    (arr) =>
      db
        .select({ serial_number: inventory.serial_number })
        .from(inventory)
        .where(inArray(inventory.serial_number, arr)),
  );

  const existingSerialSet = new Set(
    existingSerialRows
      .map((r) => r.serial_number)
      .filter((s): s is string => !!s),
  );

  const existingImeiRows = await safeInArrayQuery(
    incomingImeis,
    (arr) =>
      db
        .select({ iot_imei_no: inventory.iot_imei_no })
        .from(inventory)
        .where(inArray(inventory.iot_imei_no, arr)),
  );

  const existingImeiSet = new Set(
    existingImeiRows.map((r) => r.iot_imei_no).filter((s): s is string => !!s),
  );

  const schema = getRowSchema(assetType);

  // ── Bulk-load referenced Product Master rows once ────────────────────────
  const masterKeys =
    assetType === "paraphernalia"
      ? rows.map((r) => String(r.item_type_code || "").trim()).filter(Boolean)
      : rows.map((r) => String(r.model_id || "").trim()).filter(Boolean);

  const batteryMaster =
    assetType === "battery"
      ? await loadProductMasterBatch("battery", masterKeys)
      : new Map<string, BatteryMaster>();
  const chargerMaster =
    assetType === "charger"
      ? await loadProductMasterBatch("charger", masterKeys)
      : new Map<string, ChargerMaster>();
  const paraMaster =
    assetType === "paraphernalia"
      ? await loadProductMasterBatch("paraphernalia", masterKeys)
      : new Map<string, ParaphernaliaMaster>();

  // Legacy products lookup (preserved for back-compat with consumers that
  // filter by inventory.product_id).
  const productRows = await safeInArrayQuery(masterKeys, (arr) =>
    db
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .where(inArray(products.sku, arr)),
  );
  const productBySku = new Map(productRows.map((p) => [p.sku.toLowerCase(), p]));

  const errors: StructuredError[] = [];
  const seenSerials = new Set<string>();
  const seenImeis = new Set<string>();

  type ValidatedPayload = {
    rowNumber: number;
    r: Record<string, unknown>;
    serial: string;
    imei: string;
    inventoryId: string;
    masterKey: string;
    category: string;
    productId: string | null;
    batteryMaster: BatteryMaster | null;
    chargerMaster: ChargerMaster | null;
    paraMaster: ParaphernaliaMaster | null;
  };
  const toInsert: ValidatedPayload[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const parsed = schema.safeParse(rows[i]);

    if (!parsed.success) {
      for (const msg of formatZodErrors(parsed.error)) {
        const [field, rest] = msg.split(":");
        errors.push({
          row: rowNumber,
          field: field || "row",
          code: "VALIDATION_ERROR",
          message: rest ? rest.trim() : msg,
        });
      }
      continue;
    }

    const r = parsed.data as Record<string, unknown>;

    const serial =
      assetType === "battery"
        ? String(r.battery_id || "").trim()
        : assetType === "charger"
          ? String(r.serial_number || "").trim()
          : "";

    if (serial) {
      if (existingSerialSet.has(serial)) {
        errors.push({
          row: rowNumber,
          field: assetType === "battery" ? "battery_id" : "serial_number",
          code: "DUPLICATE_SERIAL",
          message: `Serial '${serial}' already exists in the system.`,
        });
        continue;
      }
      if (seenSerials.has(serial)) {
        errors.push({
          row: rowNumber,
          field: assetType === "battery" ? "battery_id" : "serial_number",
          code: "DUPLICATE_SERIAL_IN_FILE",
          message: `Serial '${serial}' appears more than once in this file.`,
        });
        continue;
      }
      seenSerials.add(serial);
    }

    const imei = assetType === "battery" ? String(r.imei_id || "").trim() : "";

    if (imei) {
      if (existingImeiSet.has(imei)) {
        errors.push({
          row: rowNumber,
          field: "imei_id",
          code: "IMEI_ALREADY_EXISTS",
          message: `IMEI '${imei}' is already assigned to another battery.`,
        });
        continue;
      }
      if (seenImeis.has(imei)) {
        errors.push({
          row: rowNumber,
          field: "imei_id",
          code: "IMEI_DUPLICATE_IN_FILE",
          message: `IMEI '${imei}' appears more than once in this file.`,
        });
        continue;
      }
      seenImeis.add(imei);
    }

    // ── Product Master lookup + cross-checks (BRD §5.0) ──────────────────
    const masterKey =
      assetType === "paraphernalia"
        ? String(r.item_type_code || "").trim()
        : String(r.model_id || "").trim();
    const lookup = masterKey.toLowerCase();
    const category = String(r.category || "").trim();

    let bMaster: BatteryMaster | null = null;
    let cMaster: ChargerMaster | null = null;
    let pMaster: ParaphernaliaMaster | null = null;

    if (assetType === "battery") {
      bMaster = batteryMaster.get(lookup) ?? null;
      if (!bMaster) {
        errors.push({
          row: rowNumber,
          field: "model_id",
          code: "MODEL_NOT_FOUND",
          message: `Model ID '${masterKey}' not found or inactive in battery Product Master.`,
        });
        continue;
      }
      if (
        bMaster.compatibleCategories.length &&
        !bMaster.compatibleCategories.some((c) => c.toLowerCase() === category.toLowerCase())
      ) {
        errors.push({
          row: rowNumber,
          field: "category",
          code: "CATEGORY_NOT_COMPATIBLE",
          message: `Category '${category}' is not compatible with ${bMaster.modelId}. Compatible: ${bMaster.compatibleCategories.join(", ")}.`,
        });
        continue;
      }
      if (r.iot_enabled === true && !bMaster.iotCompatible) {
        errors.push({
          row: rowNumber,
          field: "iot_enabled",
          code: "IOT_NOT_SUPPORTED",
          message: `Model '${bMaster.modelId}' is not IoT-compatible; iot_enabled cannot be Yes.`,
        });
        continue;
      }
    } else if (assetType === "charger") {
      cMaster = chargerMaster.get(lookup) ?? null;
      if (!cMaster) {
        errors.push({
          row: rowNumber,
          field: "model_id",
          code: "MODEL_NOT_FOUND",
          message: `Model ID '${masterKey}' not found or inactive in charger Product Master.`,
        });
        continue;
      }
    } else {
      pMaster = paraMaster.get(lookup) ?? null;
      if (!pMaster) {
        errors.push({
          row: rowNumber,
          field: "item_type_code",
          code: "ITEM_NOT_FOUND",
          message: `Item Type Code '${masterKey}' not found or inactive in paraphernalia Product Master.`,
        });
        continue;
      }
      if (
        pMaster.compatibleCategories.length &&
        !pMaster.compatibleCategories.some((c) => c.toLowerCase() === category.toLowerCase())
      ) {
        errors.push({
          row: rowNumber,
          field: "category",
          code: "CATEGORY_NOT_COMPATIBLE",
          message: `Category '${category}' is not compatible with ${pMaster.itemTypeCode}. Compatible: ${pMaster.compatibleCategories.join(", ")}.`,
        });
        continue;
      }
    }

    const productId = productBySku.get(lookup)?.id ?? null;

    toInsert.push({
      rowNumber,
      r,
      serial,
      imei,
      inventoryId: await generateId("INV"),
      masterKey,
      category,
      productId,
      batteryMaster: bMaster,
      chargerMaster: cMaster,
      paraMaster: pMaster,
    });
  }

  const insertedIds: string[] = [];

  const response = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1`);

    for (const payload of toInsert) {
      const {
        rowNumber,
        r,
        serial,
        imei,
        inventoryId,
        masterKey,
        category,
        productId,
        batteryMaster: bMaster,
        chargerMaster: cMaster,
        paraMaster: pMaster,
      } = payload;
      const savepointName = makeSavepoint(inventoryId);
      const now = new Date();

      await tx.execute(sql.raw(`SAVEPOINT ${savepointName}`));

      try {
        if (assetType === "battery" && bMaster) {
          const soldDate = safeDate(r.sold_date) ?? now;
          const warrantyDate = safeDate(r.oem_warranty_date) ?? soldDate;
          const oemWarrantyMonths = Number(r.oem_warranty_months || 0);
          const expiry = new Date(warrantyDate);
          expiry.setMonth(expiry.getMonth() + oemWarrantyMonths);

          const value = Number(r.invoice_value || 0);
          const gstPercent = r.gst_percent != null ? Number(r.gst_percent) : 0;
          const gstAmount = value * (gstPercent / 100);
          const finalAmount = value + gstAmount;

          const subCategory = bMaster.compatibleSubCategories[0] ?? "";
          const voltageV = bMaster.voltageV ?? "";
          const capacityAh = bMaster.capacityAh ?? "";
          const customerWarrantyMonths = bMaster.warrantyMonths;
          const iotEnabled =
            bMaster.iotCompatible &&
            (r.iot_enabled === true ||
              String(r.iot_enabled || "").toLowerCase() === "true");
          const iotImei = iotEnabled ? imei || null : null;

          await tx.insert(inventory).values({
            id: inventoryId,
            inventory_type: "battery",
            serial_number: serial,
            iot_imei_no: iotImei,
            iot_enabled: iotEnabled,
            material_code: String(r.material_code || ""),
            asset_category: category,
            asset_type: "battery",
            sub_category: subCategory,
            model_type: bMaster.modelId,
            product_id: productId,
            voltage_v: voltageV ? String(voltageV) : null,
            capacity_ah: capacityAh ? String(capacityAh) : null,
            star_rating: r.star_rating ? Number(r.star_rating) : null,
            hsn_code: r.hsn_code ? String(r.hsn_code).trim().slice(0, 8) : null,
            warranty_months: customerWarrantyMonths,
            gst_percent: gstPercent ? gstPercent.toFixed(2) : null,
            gst_amount: gstPercent ? gstAmount.toFixed(2) : null,
            oem_invoice_number: String(r.invoice_number || ""),
            oem_invoice_date: soldDate,
            inventory_amount: value.toString(),
            final_amount: finalAmount.toFixed(2),
            oem_name: String(r.supplier_name || ""),
            oem_warranty_date: warrantyDate.toISOString().slice(0, 10),
            oem_warranty_months: oemWarrantyMonths,
            oem_warranty_expiry: expiry.toISOString().slice(0, 10),
            oem_warranty_clauses: r.oem_warranty_clauses
              ? String(r.oem_warranty_clauses)
              : null,
            batch_number: r.batch_reference ? String(r.batch_reference) : null,
            physical_condition: String(r.physical_condition || "").toLowerCase(),
            warehouse_location: r.warehouse_location
              ? String(r.warehouse_location)
              : null,
            is_serialized: true,
            status: "available",
            dealer_id: dealerId,
            allocated_to_dealer_at: now,
            created_by: user.id,
            upload_event_id: null,
            created_at: now,
            updated_at: now,
          });
        } else if (assetType === "charger" && cMaster) {
          const invoiceDate = safeDate(r.invoice_date) ?? now;
          const value = Number(r.invoice_value || 0);
          const gstPercent = r.gst_percent != null ? Number(r.gst_percent) : 0;
          const gstAmount = value * (gstPercent / 100);
          const finalAmount = value + gstAmount;

          const outputVoltage = cMaster.outputVoltageV ?? "";
          const outputCurrent = cMaster.outputCurrentA ?? "";
          const compatibleBatteries = cMaster.compatibleBatteryModels;
          const customerWarrantyMonths = cMaster.warrantyMonths;

          await tx.insert(inventory).values({
            id: inventoryId,
            inventory_type: "charger",
            serial_number: serial,
            iot_enabled: false,
            asset_category: category,
            asset_type: "charger",
            sub_category: cMaster.modelName,
            model_type: cMaster.modelId,
            compatible_models: compatibleBatteries,
            output_current_a: outputCurrent ? String(outputCurrent) : null,
            voltage_v: outputVoltage ? String(outputVoltage) : null,
            product_id: productId,
            hsn_code: r.hsn_code ? String(r.hsn_code).trim().slice(0, 8) : null,
            warranty_months: customerWarrantyMonths,
            gst_percent: gstPercent ? gstPercent.toFixed(2) : null,
            gst_amount: gstPercent ? gstAmount.toFixed(2) : null,
            oem_invoice_number: String(r.invoice_number || ""),
            oem_invoice_date: invoiceDate,
            inventory_amount: value.toString(),
            final_amount: finalAmount.toFixed(2),
            oem_name: String(r.supplier_name || ""),
            physical_condition: String(r.physical_condition || "").toLowerCase(),
            warehouse_location: r.warehouse_location
              ? String(r.warehouse_location)
              : null,
            is_serialized: true,
            status: "available",
            dealer_id: dealerId,
            allocated_to_dealer_at: now,
            created_by: user.id,
            upload_event_id: null,
            created_at: now,
            updated_at: now,
          });
        } else if (assetType === "paraphernalia" && pMaster) {
          const invoiceDate = safeDate(r.invoice_date) ?? now;
          const value = Number(r.unit_cost || 0);
          const qty = Number(r.quantity || 1);
          const itemType = pMaster.itemTypeCode;
          const compatible = pMaster.compatibleCategories;
          const label = pMaster.displayLabel;

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
            oem_invoice_number: String(r.invoice_number || ""),
            oem_invoice_date: invoiceDate,
            inventory_amount: value.toString(),
            final_amount: value.toString(),
            oem_name: r.supplier ? String(r.supplier) : null,
            warehouse_location: r.warehouse_location
              ? String(r.warehouse_location)
              : null,
            is_serialized: false,
            status: "available",
            dealer_id: dealerId,
            allocated_to_dealer_at: now,
            created_by: user.id,
            upload_event_id: null,
            created_at: now,
            updated_at: now,
          });

          const stockSavepoint = makeSavepoint(`stock_${inventoryId}`);
          await tx.execute(sql.raw(`SAVEPOINT ${stockSavepoint}`));
          try {
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
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${stockSavepoint}`));
          } catch (stockError) {
            try {
              await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${stockSavepoint}`));
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${stockSavepoint}`));
            } catch {
              // ignore cleanup errors
            }
            if (
              !hasPgCode(stockError, "42P01") &&
              !hasPgCode(stockError, "42703")
            ) {
              throw stockError;
            }
            console.warn(
              "[bulk-upload] paraphernalia_stock update skipped:",
              getPgCode(stockError),
            );
          }
        }

        insertedIds.push(inventoryId);

        const logSavepoint = makeSavepoint(`log_${inventoryId}`);
        await tx.execute(sql.raw(`SAVEPOINT ${logSavepoint}`));
        try {
          await logInventoryEvent({
            tx,
            serialNumber: serial || `${assetType}:${inventoryId}`,
            inventoryId,
            eventType: "uploaded",
            fromStatus: null,
            toStatus: "available",
            performedBy: user.id,
            notes: `Bulk upload row ${rowNumber}`,
            metadata: { dealerId, assetType, modelId: masterKey, row: rowNumber },
            performedAt: now,
          });
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${logSavepoint}`));
        } catch (logError) {
          try {
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${logSavepoint}`));
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${logSavepoint}`));
          } catch {
            // ignore cleanup errors
          }
          if (
            !hasPgCode(logError, "42P01") &&
            !hasPgCode(logError, "42703")
          ) {
            throw logError;
          }
          console.warn("[bulk-upload] event log skipped:", getPgCode(logError));
        }

        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));
      } catch (rowError: unknown) {
        try {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));
        } catch {
          throw rowError;
        }

        const code = getPgCode(rowError);
        errors.push({
          row: rowNumber,
          field: "row",
          code: code || "INSERT_FAILED",
          message:
            code === "22001"
              ? "One field value is longer than the database column allows. Check material_code, serial_number, model_id, or batch_reference."
              : (rowError as Error)?.message || "Failed to insert this row.",
        });
      }
    }

    const reportId = await generateId("UPL");
    const reportUrl = `/api/admin/inventory/upload-report/${reportId}`;
    const skippedRowCount = new Set(errors.map((e) => e.row)).size;

    const reportSavepoint = makeSavepoint(`report_${reportId}`);
    await tx.execute(sql.raw(`SAVEPOINT ${reportSavepoint}`));

    try {
      await tx.insert(inventoryUploadReports).values({
        id: reportId,
        dealer_id: dealerId,
        asset_type: assetType,
        inventory_type: assetType,
        upload_method: "csv",
        uploaded_by: user.id,
        uploaded_at: new Date(),
        total_rows: rows.length,
        inserted_rows: insertedIds.length,
        skipped_rows: skippedRowCount,
        rows_imported: insertedIds.length,
        rows_skipped: skippedRowCount,
        errors_json: errors,
        inserted_inventory_ids: insertedIds,
        source: "bulk",
        report_url: reportUrl,
      });
      await tx.execute(sql.raw(`RELEASE SAVEPOINT ${reportSavepoint}`));
    } catch (reportError) {
      await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${reportSavepoint}`));

      if (
        !hasPgCode(reportError, "42P01") &&
        !hasPgCode(reportError, "42703")
      ) {
        throw reportError;
      }

      try {
        await tx.execute(sql`
          insert into inventory_upload_reports
            (id, dealer_id, asset_type, uploaded_by, uploaded_at, total_rows, inserted_rows,
             skipped_rows, errors_json, inserted_inventory_ids, source)
          values
            (${reportId}, ${dealerId}, ${assetType}, ${user.id}, ${new Date()}, ${rows.length},
             ${insertedIds.length}, ${skippedRowCount}, ${JSON.stringify(errors)}::jsonb,
             ${JSON.stringify(insertedIds)}::jsonb, ${"bulk"})
        `);
      } catch (fallbackError) {
        if (
          !hasPgCode(fallbackError, "42P01") &&
          !hasPgCode(fallbackError, "42703")
        ) {
          throw fallbackError;
        }
      }
    }

    if (insertedIds.length) {
      try {
        await tx
          .update(inventory)
          .set({ upload_event_id: reportId, updated_at: new Date() })
          .where(inArray(inventory.id, insertedIds));
      } catch (updateError) {
        if (!hasPgCode(updateError, "42703")) throw updateError;
      }
    }

    if (insertedIds.length > 0) {
      await notifyInventoryAssigned({
        dealerId,
        assetType,
        count: insertedIds.length,
        reportId,
      });
    }

    return successResponse({
      success: true,
      uploadEventId: reportId,
      totalRows: rows.length,
      imported: insertedIds.length,
      skipped: skippedRowCount,
      errors,
      reportUrl,
    });
  });

  return response;
});
