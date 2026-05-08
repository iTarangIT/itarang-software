import { z } from "zod";
import { AssetType } from "./csv-templates";

export const CATEGORY_LIST = ["3W", "2W", "4W", "Inverter", "Solar", "Other"] as const;
export type Category = (typeof CATEGORY_LIST)[number];
const CATEGORIES = new Set<string>(CATEGORY_LIST);
export const canonicalCategory = (raw: string): string => {
  const lower = raw.trim().toLowerCase();
  return CATEGORY_LIST.find((c) => c.toLowerCase() === lower) ?? raw.trim();
};
export const PHYSICAL_CONDITIONS = ["new", "refurbished", "demo"] as const;
export type PhysicalCondition = (typeof PHYSICAL_CONDITIONS)[number];

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

// Battery row contract — voltage_v / capacity_ah / sub_category are now
// hydrated server-side from product master via model_id, so they are no
// longer accepted as inputs here.
const batteryRowSchema = z
  .object({
    model_id: z.string().min(1, "Model ID is required"),
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
      .transform(canonicalCategory)
      .refine(
        (v) => CATEGORIES.has(v),
        "Category must be one of: 3W, 2W, 4W, Inverter, Solar, Other",
      ),
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
    hsn_code: z
      .string()
      .trim()
      .max(8, "HSN max 8 chars")
      .optional()
      .nullable(),
    gst_percent: z.coerce
      .number()
      .min(0)
      .max(50)
      .optional()
      .nullable(),
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
  model_id: z.string().min(1, "Model ID is required"),
  serial_number: z
    .string()
    .min(1, "Serial Number is required")
    .max(50, "Serial Number max 50 chars")
    .regex(/^[A-Za-z0-9\-_]+$/, "Serial Number must be alphanumeric"),
  category: z
    .string()
    .min(1)
    .transform(canonicalCategory)
    .refine(
      (v) => CATEGORIES.has(v),
      "Category must be one of: 3W, 2W, 4W, Inverter, Solar, Other",
    ),
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
  hsn_code: z
    .string()
    .trim()
    .max(8, "HSN max 8 chars")
    .optional()
    .nullable(),
  gst_percent: z.coerce.number().min(0).max(50).optional().nullable(),
});

const paraphernaliaRowSchema = z.object({
  item_type_code: z.string().min(1, "Item Type Code is required"),
  category: z
    .string()
    .min(1)
    .transform(canonicalCategory)
    .refine(
      (v) => CATEGORIES.has(v),
      "Category must be one of: 3W, 2W, 4W, Inverter, Solar, Other",
    ),
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
