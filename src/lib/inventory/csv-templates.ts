// BRD strict per-type CSV templates for admin inventory upload.
// Column order intentionally mirrors BRD contract.
//
// Model ID is the handshake into Product Master. Voltage, capacity,
// sub_category, warranty (customer), and chemistry are no longer asked for in
// the CSV — they are hydrated server-side from the matching active product
// master row.

export type AssetType = "battery" | "charger" | "paraphernalia";

export const ASSET_TYPES: AssetType[] = ["battery", "charger", "paraphernalia"];

export interface CsvTemplate {
  type: AssetType;
  description: string;
  headers: string[];
  samples: string[][];
}

const BATTERY_HEADERS = [
  "model_id",
  "battery_id",
  "category",
  "iot_enabled",
  "imei_id",
  "material_code",
  "star_rating",
  "invoice_number",
  "sold_date",
  "invoice_value",
  "hsn_code",
  "gst_percent",
  "supplier_name",
  "oem_warranty_date",
  "oem_warranty_months",
  "oem_warranty_clauses",
  "batch_reference",
  "physical_condition",
  "warehouse_location",
];

const CHARGER_HEADERS = [
  "model_id",
  "serial_number",
  "category",
  "invoice_number",
  "invoice_date",
  "invoice_value",
  "hsn_code",
  "gst_percent",
  "supplier_name",
  "physical_condition",
  "warehouse_location",
];

const PARAPHERNALIA_HEADERS = [
  "item_type_code",
  "category",
  "quantity",
  "unit_cost",
  "invoice_number",
  "invoice_date",
  "supplier",
  "warehouse_location",
];

export const CSV_TEMPLATES: Record<AssetType, CsvTemplate> = {
  battery: {
    type: "battery",
    description:
      "Serialized battery upload template. model_id must exist in Product Master (active). voltage, capacity, sub_category, chemistry, customer warranty are auto-filled from the master.",
    headers: BATTERY_HEADERS,
    samples: [],
  },
  charger: {
    type: "charger",
    description:
      "Serialized charger upload template. model_id must exist in Product Master (active). output voltage/current and compatible battery models are auto-filled from the master.",
    headers: CHARGER_HEADERS,
    samples: [
      [
        "CHG-51V-20A-FAST",
        "CHR-3W-0001",
        "3W",
        "INV-2026-0045",
        "2026-01-15",
        "6500",
        "85044090",
        "18",
        "XYZ Battery Co.",
        "new",
        "Main Godown",
      ],
    ],
  },
  paraphernalia: {
    type: "paraphernalia",
    description:
      "Quantity-tracked paraphernalia template. item_type_code must exist in Product Master (active). compatible categories are auto-filled from the master.",
    headers: PARAPHERNALIA_HEADERS,
    samples: [
      [
        "digital_soc",
        "3W",
        "20",
        "450",
        "INV-2026-PARA-1001",
        "2026-01-20",
        "Accessory Vendor",
        "Main Godown",
      ],
    ],
  },
};

export function buildCsvContent(template: CsvTemplate): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [template.headers.map(escape).join(",")];
  for (const row of template.samples) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\n");
}
