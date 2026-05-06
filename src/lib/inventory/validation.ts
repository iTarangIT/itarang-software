import { z } from "zod";
import { AssetType } from "./csv-templates";

const CATEGORIES = new Set(["3W", "2W", "4W", "Inverter", "Solar", "Other"]);
const PHYSICAL_CONDITIONS = ["new", "refurbished", "demo"] as const;

const yesNoBool = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
    const s = v.trim().toLowerCase();
    return s === "yes" || s === "true" || s === "1";
  });

const dateString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date format");

const soldDateString = dateString.refine(
  (s) => new Date(s).getTime() <= Date.now(),
  "Sold Date cannot be in the future",
);

const batteryRowSchema = z
  .object({
    battery_id: z
      .string()
      .min(1, "Battery ID is required")
      .max(50, "Battery ID max 50 chars")
      .regex(/^[A-Za-z0-9\-_]+$/, "Battery ID must be alphanumeric"),
    imei_id: z
      .string()
      .trim()
      .optional()
      .nullable()
      .refine((v) => !v || /^[0-9]{15}$/.test(v), "IMEI ID must be 15 digits"),
    iot_enabled: yesNoBool,
    material_code: z.string().min(1, "Material Code is required"),
    category: z
      .string()
      .min(1)
      .refine((v) => CATEGORIES.has(v), "Category is invalid"),
    sub_category: z.string().min(1, "Sub-Category is required"),
    model_number: z.string().min(1, "Model Number is required"),
    voltage_v: z.coerce.number().positive("Voltage must be positive"),
    capacity_ah: z.coerce.number().positive("Capacity must be positive"),
    star_rating: z.coerce.number().int().min(1).max(5),
    invoice_number: z.string().min(1, "Invoice Number is required"),
    sold_date: soldDateString,
    invoice_value: z.coerce.number().positive("Invoice Value must be positive"),
    supplier_name: z.string().min(1, "Supplier Name is required"),
    oem_warranty_date: dateString,
    oem_warranty_months: z.coerce.number().int().positive("Warranty months must be positive"),
    oem_warranty_clauses: z.string().optional().nullable(),
    batch_reference: z.string().optional().nullable(),
    physical_condition: z
      .string()
      .min(1)
      .transform((v) => v.toLowerCase())
      .refine(
        (v) => (PHYSICAL_CONDITIONS as readonly string[]).includes(v),
        "Physical Condition must be new|refurbished|demo",
      ),
    warehouse_location: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.iot_enabled && (!data.imei_id || data.imei_id.trim() === "")) {
      ctx.addIssue({
        code: "custom",
        path: ["imei_id"],
        message: "IMEI ID is required when IoT Enabled = Yes.",
      });
    }
  });

const chargerRowSchema = z.object({
  serial_number: z
    .string()
    .min(1, "Serial Number is required")
    .max(50, "Serial Number max 50 chars")
    .regex(/^[A-Za-z0-9\-_]+$/, "Serial Number must be alphanumeric"),
  charger_model: z.string().min(1, "Charger Model is required"),
  compatible_battery_models: z.string().min(1, "Compatible Battery Models is required"),
  output_voltage_v: z.coerce.number().positive("Output Voltage must be positive"),
  output_current_a: z.coerce.number().positive("Output Current must be positive"),
  invoice_number: z.string().min(1, "Invoice Number is required"),
  invoice_date: soldDateString,
  invoice_value: z.coerce.number().positive("Invoice Value must be positive"),
  supplier_name: z.string().min(1, "Supplier Name is required"),
  physical_condition: z
    .string()
    .min(1)
    .transform((v) => v.toLowerCase())
    .refine(
      (v) => (PHYSICAL_CONDITIONS as readonly string[]).includes(v),
      "Physical Condition must be new|refurbished|demo",
    ),
  warehouse_location: z.string().optional().nullable(),
});

const paraphernaliaRowSchema = z.object({
  item_type: z.string().min(1, "Item Type is required"),
  compatible_category: z.string().min(1, "Compatible Category is required"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  unit_cost: z.coerce.number().positive("Unit Cost must be positive"),
  invoice_number: z.string().min(1, "Invoice Number is required"),
  invoice_date: soldDateString,
  supplier: z.string().optional().nullable(),
  warehouse_location: z.string().optional().nullable(),
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
  rowIndex: number;
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
