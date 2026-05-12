import { z } from "zod";
import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler, generateId } from "@/lib/api-utils";

const bodySchema = z.object({
  dealerId: z.string().min(1, "dealerId is required"),
  assetType: z.enum(["battery", "charger", "paraphernalia"]),
  rows: z.array(z.record(z.string(), z.any())).min(1, "rows are required"),
});

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toString() : null;
}

function clean(value: unknown): string | null {
  const v = String(value ?? "").trim();
  return v.length ? v : null;
}

function getPgCode(error: unknown): string | null {
  let current: unknown = error;

  while (current && typeof current === "object") {
    const record = current as { code?: string; cause?: unknown };
    if (record.code) return record.code;
    current = record.cause;
  }

  return null;
}

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();

  const body = bodySchema.parse(await req.json());
  const { dealerId, assetType, rows } = body;

  const results = {
    uploadEventId: await generateId("UPL"),
    totalRows: rows.length,
    imported: 0,
    skipped: 0,
    errors: [] as Array<{
      row: number;
      field: string;
      code: string;
      message: string;
    }>,
    insertedIds: [] as string[],
  };

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const r = rows[i];

    try {
      const inventoryId = await generateId("INV");

      const serial =
        assetType === "battery"
          ? clean(r.battery_id ?? r.serial_number)
          : assetType === "charger"
            ? clean(r.serial_number)
            : null;

      if ((assetType === "battery" || assetType === "charger") && !serial) {
        results.skipped++;
        results.errors.push({
          row: rowNumber,
          field: assetType === "battery" ? "battery_id" : "serial_number",
          code: "SERIAL_REQUIRED",
          message: "Serial number is required.",
        });
        continue;
      }

      const invoiceValue =
        assetType === "paraphernalia"
          ? toNumberString(r.unit_cost ?? r.inventory_amount)
          : toNumberString(r.invoice_value ?? r.inventory_amount);

      const invoiceDate =
        assetType === "battery"
          ? toDate(r.sold_date ?? r.invoice_date ?? r.oem_invoice_date)
          : toDate(r.invoice_date ?? r.oem_invoice_date);

      const quantity =
        assetType === "paraphernalia"
          ? Number(r.quantity || 1)
          : 1;

      const modelType =
        assetType === "battery"
          ? clean(r.model_number) || "Battery"
          : assetType === "charger"
            ? clean(r.charger_model) || "Charger"
            : clean(r.item_type) || "Paraphernalia";

      const assetCategory =
        assetType === "battery"
          ? clean(r.category) || "Battery"
          : assetType === "charger"
            ? clean(r.compatible_battery_models) || "Charger"
            : clean(r.compatible_category) || "Accessory";

      const subCategory =
        assetType === "battery"
          ? clean(r.sub_category)
          : assetType === "charger"
            ? clean(r.charger_model)
            : clean(r.item_type);

      const warrantyDate = toDate(r.oem_warranty_date);
      const warrantyMonths = Number(r.oem_warranty_months || r.warranty_months || 0);

      let warrantyExpiry: Date | null = null;
      if (warrantyDate && warrantyMonths > 0) {
        warrantyExpiry = new Date(warrantyDate);
        warrantyExpiry.setMonth(warrantyExpiry.getMonth() + warrantyMonths);
      }

      const [created] = await db
        .insert(inventory)
        .values({
          id: inventoryId,

          inventory_type:
            assetType === "paraphernalia" ? "paraphernalia_lot" : assetType,

          asset_category: assetCategory,
          asset_type: assetType,
          sub_category: subCategory,
          model_type: modelType,

          serial_number: serial,
          material_code: clean(r.material_code ?? r.hsn_code),
          batch_number: clean(r.batch_reference ?? r.batch_number),

          is_serialized: assetType !== "paraphernalia",
          quantity,

          iot_enabled:
            String(r.iot_enabled ?? "").toLowerCase() === "true" ||
            String(r.iot_enabled ?? "") === "1",
          iot_imei_no: clean(r.imei_id ?? r.iot_imei_no),

          voltage_v: toNumberString(r.voltage_v),
          capacity_ah: toNumberString(r.capacity_ah),
          output_current_a: toNumberString(r.output_current_a),
          star_rating: r.star_rating ? Number(r.star_rating) : null,

          oem_name: clean(r.supplier_name ?? r.supplier ?? r.oem_name),
          oem_invoice_number: clean(r.invoice_number ?? r.oem_invoice_number),
          oem_invoice_date: invoiceDate,

          inventory_amount: invoiceValue,
          final_amount: invoiceValue,

          warehouse_location: clean(r.warehouse_location),
          physical_condition: clean(r.physical_condition)?.toLowerCase(),

          oem_warranty_date: warrantyDate
            ? warrantyDate.toISOString().slice(0, 10)
            : null,
          oem_warranty_months: warrantyMonths || null,
          oem_warranty_expiry: warrantyExpiry
            ? warrantyExpiry.toISOString().slice(0, 10)
            : null,
          oem_warranty_clauses: clean(r.oem_warranty_clauses),

          status: "available",
          dealer_id: dealerId,
          allocated_to_dealer_at: new Date(),

          created_by: user.id,
          upload_event_id: results.uploadEventId,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning({ id: inventory.id });

      results.imported++;
      results.insertedIds.push(created.id);
    } catch (error: any) {
      const code = getPgCode(error);

      results.skipped++;

      if (code === "23505") {
        results.errors.push({
          row: rowNumber,
          field: "serial_number",
          code: "DUPLICATE_SERIAL_OR_IMEI",
          message:
            "This serial number or IMEI already exists. Please use a unique value.",
        });
      } else {
        results.errors.push({
          row: rowNumber,
          field: "row",
          code: code || "INSERT_FAILED",
          message: error?.message || "Failed to insert this row.",
        });
      }
    }
  }

  return successResponse({
    success: true,
    uploadEventId: results.uploadEventId,
    totalRows: results.totalRows,
    imported: results.imported,
    skipped: results.skipped,
    errors: results.errors,
    insertedInventoryIds: results.insertedIds,
  });
});