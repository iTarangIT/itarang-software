// Per-asset-type Zod schemas for the admin bulk-upload validate + commit
// endpoints. Battery and Charger require serial numbers; Paraphernalia is
// count-based with quantity instead.

import { z } from "zod";
import { AssetType } from "./csv-templates";

const dateString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

const trueFalse = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : v.toLowerCase() === "true" || v === "1",
  );

const baseShape = {
  hsn_code: z.string().regex(/^[0-9]{8}$/, "HSN must be 8 digits"),
  oem_name: z.string().min(1, "OEM name required"),
  inventory_amount: z.coerce.number().positive("Must be > 0"),
  gst_percent: z.coerce
    .number()
    .refine((v) => [0, 5, 12, 18, 28].includes(v), "GST must be 0/5/12/18/28"),
  warranty_months: z.coerce.number().int().nonnegative(),
  manufacturing_date: dateString,
  expiry_date: dateString,
  oem_invoice_number: z.string().min(1, "OEM invoice number required"),
  oem_invoice_date: dateString,
  warehouse_location: z.string().optional().nullable(),
  physical_condition: z.string().optional().nullable(),
};

export const batteryRowSchema = z.object({
  ...baseShape,
  serial_number: z.string().min(1, "Battery requires serial number"),
  is_serialized: trueFalse.default(true),
  iot_imei_no: z.string().optional().nullable(),
  batch_number: z.string().optional().nullable(),
  voltage_v: z.coerce.number().int().positive().optional(),
  capacity_ah: z.coerce.number().int().positive().optional(),
});

export const chargerRowSchema = z.object({
  ...baseShape,
  serial_number: z.string().min(1, "Charger requires serial number"),
  is_serialized: trueFalse.default(true),
  compatible_battery_voltage: z.coerce.number().int().positive().optional(),
});

export const paraphernaliaRowSchema = z.object({
  hsn_code: z.string().regex(/^[0-9]{8}$/, "HSN must be 8 digits"),
  oem_name: z.string().min(1, "OEM name required"),
  inventory_amount: z.coerce.number().positive(),
  gst_percent: z.coerce
    .number()
    .refine((v) => [0, 5, 12, 18, 28].includes(v), "GST must be 0/5/12/18/28"),
  warranty_months: z.coerce.number().int().nonnegative().default(0),
  manufacturing_date: dateString,
  expiry_date: dateString,
  oem_invoice_number: z.string().min(1),
  oem_invoice_date: dateString,
  warehouse_location: z.string().optional().nullable(),
  asset_type: z.string().min(1, "asset_type required (e.g. Helmet, Cable)"),
  model_type: z.string().min(1, "model_type required"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
});

export type BatteryRow = z.infer<typeof batteryRowSchema>;
export type ChargerRow = z.infer<typeof chargerRowSchema>;
export type ParaphernaliaRow = z.infer<typeof paraphernaliaRowSchema>;

export function getRowSchema(type: AssetType) {
  switch (type) {
    case "battery":
      return batteryRowSchema;
    case "charger":
      return chargerRowSchema;
    case "paraphernalia":
      return paraphernaliaRowSchema;
  }
}

export interface ValidatedRow {
  rowIndex: number; // 1-based row number in the source CSV (header = row 1)
  status: "valid" | "error";
  data: Record<string, unknown> | null;
  errors: string[];
}

export function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}
