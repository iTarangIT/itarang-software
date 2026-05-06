// BRD strict per-type CSV templates for admin inventory upload.
// Column order intentionally mirrors BRD contract.

export type AssetType = "battery" | "charger" | "paraphernalia";

export const ASSET_TYPES: AssetType[] = ["battery", "charger", "paraphernalia"];

export interface CsvTemplate {
  type: AssetType;
  description: string;
  headers: string[];
  samples: string[][];
}

const BATTERY_HEADERS = [
  "battery_id",
  "imei_id",
  "iot_enabled",
  "material_code",
  "category",
  "sub_category",
  "model_number",
  "voltage_v",
  "capacity_ah",
  "star_rating",
  "invoice_number",
  "sold_date",
  "invoice_value",
  "supplier_name",
  "oem_warranty_date",
  "oem_warranty_months",
  "oem_warranty_clauses",
  "batch_reference",
  "physical_condition",
  "warehouse_location",
];

const CHARGER_HEADERS = [
  "serial_number",
  "charger_model",
  "compatible_battery_models",
  "output_voltage_v",
  "output_current_a",
  "invoice_number",
  "invoice_date",
  "invoice_value",
  "supplier_name",
  "physical_condition",
  "warehouse_location",
];

const PARAPHERNALIA_HEADERS = [
  "item_type",
  "compatible_category",
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
    description: "Serialized battery upload template (BRD strict).",
    headers: BATTERY_HEADERS,
    samples: [
      [
        "BAT-3W-0001",
        "352099001428301",
        "Yes",
        "OEM-MAT-5V105-003",
        "3W",
        "51.2 V-105AH",
        "BAT-51V-105AH-3W",
        "51.2",
        "105",
        "4",
        "INV-2026-0045",
        "2026-01-15",
        "62000",
        "XYZ Battery Co.",
        "2026-01-15",
        "24",
        "Warranty void if water damage detected.",
        "PO-2026-XYZ-011",
        "new",
        "Main Godown",
      ],
    ],
  },
  charger: {
    type: "charger",
    description: "Serialized charger upload template (BRD strict).",
    headers: CHARGER_HEADERS,
    samples: [
      [
        "CHR-3W-0001",
        "CHG-51V-20A-FAST",
        "BAT-51V-105AH-3W|BAT-51V-140AH-3W",
        "51.2",
        "20",
        "INV-2026-0045",
        "2026-01-15",
        "6500",
        "XYZ Battery Co.",
        "new",
        "Main Godown",
      ],
    ],
  },
  paraphernalia: {
    type: "paraphernalia",
    description: "Quantity-tracked paraphernalia template (BRD strict).",
    headers: PARAPHERNALIA_HEADERS,
    samples: [
      [
        "digital_soc",
        "3W|2W",
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
