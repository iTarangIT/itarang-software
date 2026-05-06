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

function clean(value: unknown): string | null {
  const v = String(value ?? "").trim();
  return v.length ? v : null;
}

const bodySchema = z.object({
  dealerId: z.string().min(1, "dealerId required"),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  rows: z.array(z.record(z.string(), z.any())).min(1, "rows required"),
});

const splitList = (value: unknown): string[] =>
  String(value || "")
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);

export const POST = withErrorHandler(async (req: Request) => {
  console.log("🔥 CORRECT ADMIN BULK UPLOAD ROUTE HIT");

  const user = await requireInventoryAdmin();
  const body = bodySchema.parse(await req.json());

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

  const existingSerialRows = incomingSerials.length
    ? await db
      .select({ serial_number: inventory.serial_number })
      .from(inventory)
      .where(inArray(inventory.serial_number, incomingSerials))
    : [];

  const existingSerialSet = new Set(
    existingSerialRows
      .map((r) => r.serial_number)
      .filter((s): s is string => !!s),
  );

  const existingImeiRows = incomingImeis.length
    ? await db
      .select({ iot_imei_no: inventory.iot_imei_no })
      .from(inventory)
      .where(inArray(inventory.iot_imei_no, incomingImeis))
    : [];

  const existingImeiSet = new Set(
    existingImeiRows.map((r) => r.iot_imei_no).filter((s): s is string => !!s),
  );

  const schema = getRowSchema(assetType);

  const modelKeys =
    assetType === "battery"
      ? rows.map((r) => String(r.model_number || "").trim()).filter(Boolean)
      : assetType === "charger"
        ? rows.map((r) => String(r.charger_model || "").trim()).filter(Boolean)
        : [];

  const productRows = modelKeys.length
    ? await db
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .where(inArray(products.sku, modelKeys))
    : [];

  const productBySku = new Map(productRows.map((p) => [p.sku, p]));

  const errors: StructuredError[] = [];
  const insertedIds: string[] = [];
  const seenSerials = new Set<string>();
  const seenImeis = new Set<string>();

  const response = await db.transaction(async (tx) => {
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

      const now = new Date();
      const inventoryId = await generateId("INV");
      const savepointName = `sp_${inventoryId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

      await tx.execute(sql.raw(`SAVEPOINT ${savepointName}`));

      try {
        if (assetType === "battery") {
          const soldDate = safeDate(r.sold_date) ?? now;
          const warrantyDate = safeDate(r.oem_warranty_date) ?? soldDate;
          const warrantyMonths = Number(r.oem_warranty_months || 0);
          const expiry = new Date(warrantyDate);
          expiry.setMonth(expiry.getMonth() + warrantyMonths);

          const value = Number(r.invoice_value || 0);
          const product = productBySku.get(String(r.model_number || ""));

          try {
            await tx.insert(inventory).values({
              id: inventoryId,
              inventory_type: "battery",
              serial_number: serial,
              iot_imei_no: imei || null,
              iot_enabled:
                String(r.iot_enabled || "").toLowerCase() === "true" ||
                String(r.iot_enabled || "") === "1",

              // IMPORTANT:
              // OEM-MAT-5V105-001 is material_code, not hsn_code.
              material_code: String(r.material_code || ""),

              asset_category: String(r.category || ""),
              asset_type: "battery",
              sub_category: String(r.sub_category || ""),
              model_type: String(r.model_number || ""),
              product_id: product?.id ?? null,

              voltage_v: String(r.voltage_v || ""),
              capacity_ah: String(r.capacity_ah || ""),
              star_rating: r.star_rating ? Number(r.star_rating) : null,

              oem_invoice_number: String(r.invoice_number || ""),
              oem_invoice_date: soldDate,

              inventory_amount: value.toString(),
              final_amount: value.toString(),

              oem_name: String(r.supplier_name || ""),

              oem_warranty_date: warrantyDate.toISOString().slice(0, 10),
              oem_warranty_months: warrantyMonths,
              oem_warranty_expiry: expiry.toISOString().slice(0, 10),
              oem_warranty_clauses: r.oem_warranty_clauses
                ? String(r.oem_warranty_clauses)
                : null,

              batch_number: r.batch_reference
                ? String(r.batch_reference)
                : null,

              physical_condition: String(
                r.physical_condition || "",
              ).toLowerCase(),

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
          } catch (error) {
            if (!hasPgCode(error, "42703")) throw error;

            await tx.execute(sql`
              insert into inventory
                (id, oem_name, material_code, asset_category, asset_type, model_type, serial_number,
                 is_serialized, warranty_months, status, batch_number, dealer_id, allocated_to_dealer_at,
                 created_by, created_at, updated_at, product_id, inventory_amount, final_amount,
                 oem_invoice_number, oem_invoice_date, warehouse_location, iot_imei_no)
              values
                (${inventoryId}, ${String(r.supplier_name || "")}, ${String(r.material_code || "")},
                 ${String(r.category || "")}, ${"battery"}, ${String(r.model_number || "")}, ${serial},
                 ${true}, ${warrantyMonths}, ${"available"}, ${r.batch_reference ? String(r.batch_reference) : null},
                 ${dealerId}, ${now}, ${user.id}, ${now}, ${now}, ${product?.id ?? null},
                 ${value.toString()}, ${value.toString()}, ${String(r.invoice_number || "")}, ${soldDate},
                 ${r.warehouse_location ? String(r.warehouse_location) : null}, ${imei || null})
            `);
          }
        } else if (assetType === "charger") {
          const invoiceDate = safeDate(r.invoice_date) ?? now;
          const value = Number(r.invoice_value || 0);
          const chargerModel = String(r.charger_model || "");
          const product = productBySku.get(chargerModel);
          const compatible = splitList(r.compatible_battery_models);

          try {
            await tx.insert(inventory).values({
              id: inventoryId,
              inventory_type: "charger",
              serial_number: serial,
              iot_enabled: false,

              asset_category: compatible[0] || "Other",
              asset_type: "charger",
              sub_category: chargerModel,
              model_type: chargerModel,
              compatible_models: compatible,

              output_current_a: String(r.output_current_a || ""),
              voltage_v: String(r.output_voltage_v || ""),

              product_id: product?.id ?? null,
              oem_invoice_number: String(r.invoice_number || ""),
              oem_invoice_date: invoiceDate,

              inventory_amount: value.toString(),
              final_amount: value.toString(),

              oem_name: String(r.supplier_name || ""),
              physical_condition: String(
                r.physical_condition || "",
              ).toLowerCase(),
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
          } catch (error) {
            if (!hasPgCode(error, "42703")) throw error;

            await tx.execute(sql`
              insert into inventory
                (id, oem_name, asset_category, asset_type, model_type, serial_number,
                 is_serialized, status, dealer_id, allocated_to_dealer_at, created_by, created_at, updated_at,
                 product_id, inventory_amount, final_amount, oem_invoice_number, oem_invoice_date, warehouse_location)
              values
                (${inventoryId}, ${String(r.supplier_name || "")}, ${compatible[0] || "Other"}, ${"charger"},
                 ${chargerModel}, ${serial}, ${true}, ${"available"}, ${dealerId}, ${now}, ${user.id},
                 ${now}, ${now}, ${product?.id ?? null}, ${value.toString()}, ${value.toString()},
                 ${String(r.invoice_number || "")}, ${invoiceDate}, ${r.warehouse_location ? String(r.warehouse_location) : null})
            `);
          }
        } else {
          const invoiceDate = safeDate(r.invoice_date) ?? now;
          const value = Number(r.unit_cost || 0);
          const qty = Number(r.quantity || 1);
          const itemType = String(r.item_type || "");
          const compatible = splitList(r.compatible_category);

          const label = itemType
            .split("_")
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(" ");

          try {
            await tx.insert(inventory).values({
              id: inventoryId,
              inventory_type: "paraphernalia_lot",
              serial_number: null,
              iot_enabled: false,

              asset_category: compatible[0] || "Other",
              asset_type: itemType,
              sub_category: compatible[0] || "Other",
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
          } catch (error) {
            if (!hasPgCode(error, "42703")) throw error;

            await tx.execute(sql`
              insert into inventory
                (id, oem_name, asset_category, asset_type, model_type, serial_number, quantity,
                 is_serialized, status, dealer_id, allocated_to_dealer_at, created_by, created_at, updated_at,
                 inventory_amount, final_amount, oem_invoice_number, oem_invoice_date, warehouse_location)
              values
                (${inventoryId}, ${r.supplier ? String(r.supplier) : null}, ${compatible[0] || "Other"},
                 ${itemType}, ${label}, ${null}, ${qty}, ${false}, ${"available"}, ${dealerId}, ${now},
                 ${user.id}, ${now}, ${now}, ${value.toString()}, ${value.toString()},
                 ${String(r.invoice_number || "")}, ${invoiceDate},
                 ${r.warehouse_location ? String(r.warehouse_location) : null})
            `);
          }

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
          } catch (error) {
            if (!hasPgCode(error, "42P01") && !hasPgCode(error, "42703")) {
              throw error;
            }
          }
        }

        insertedIds.push(inventoryId);

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
            metadata: { dealerId, assetType, row: rowNumber },
            performedAt: now,
          });
        } catch (error) {
          if (!hasPgCode(error, "42P01") && !hasPgCode(error, "42703")) {
            throw error;
          }
        }
      } catch (error: any) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));

        const code = getPgCode(error);

        errors.push({
          row: rowNumber,
          field: "row",
          code: code || "INSERT_FAILED",
          message:
            code === "22001"
              ? "One field value is longer than the database column allows. Check material_code, serial_number, model_number, or batch_reference."
              : error?.message || "Failed to insert this row.",
        });
      }
    }

    const reportId = await generateId("UPL");
    const reportUrl = `/api/admin/inventory/upload-report/${reportId}`;
    const skippedRowCount = new Set(errors.map((e) => e.row)).size;

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
    } catch (error) {
      if (!hasPgCode(error, "42P01") && !hasPgCode(error, "42703")) {
        throw error;
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
        if (!hasPgCode(fallbackError, "42P01") && !hasPgCode(fallbackError, "42703")) {
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
      } catch (error) {
        if (!hasPgCode(error, "42703")) throw error;
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