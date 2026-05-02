// Per-asset-type CSV templates for the admin bulk inventory upload (BRD Step 4).
// Each template defines the column header order shown in the downloadable CSV
// and a single example row so admins can see the expected format.

export type AssetType = "battery" | "charger" | "paraphernalia";

export const ASSET_TYPES: AssetType[] = ["battery", "charger", "paraphernalia"];

export interface CsvTemplate {
  type: AssetType;
  description: string;
  headers: string[];
  sample: string[];
}

const COMMON_HEADERS = [
  "hsn_code",
  "oem_name",
  "inventory_amount",
  "gst_percent",
  "warranty_months",
  "manufacturing_date",
  "expiry_date",
  "oem_invoice_number",
  "oem_invoice_date",
  "warehouse_location",
  "physical_condition",
];

const BATTERY_HEADERS = [
  ...COMMON_HEADERS,
  "serial_number",
  "is_serialized",
  "iot_imei_no",
  "batch_number",
  "voltage_v",
  "capacity_ah",
];

const CHARGER_HEADERS = [
  ...COMMON_HEADERS,
  "serial_number",
  "is_serialized",
  "compatible_battery_voltage",
];

// Paraphernalia is count-based — one row per (asset_type, model_type) batch
// with a quantity. No serial.
const PARAPHERNALIA_HEADERS = [
  "hsn_code",
  "oem_name",
  "inventory_amount",
  "gst_percent",
  "warranty_months",
  "manufacturing_date",
  "expiry_date",
  "oem_invoice_number",
  "oem_invoice_date",
  "warehouse_location",
  "asset_type",
  "model_type",
  "quantity",
];

export const CSV_TEMPLATES: Record<AssetType, CsvTemplate> = {
  battery: {
    type: "battery",
    description: "Serialized battery units. One row per physical battery.",
    headers: BATTERY_HEADERS,
    sample: [
      "85076000",
      "Exide Industries",
      "85000",
      "18",
      "36",
      "2026-01-10",
      "2031-01-10",
      "INV-EXD-0421",
      "2026-01-15",
      "Warehouse A",
      "new",
      "BAT-EXD-0001",
      "true",
      "IMEI123456789012",
      "BATCH-EXD-Q1",
      "51",
      "105",
    ],
  },
  charger: {
    type: "charger",
    description: "Serialized charger units. One row per physical charger.",
    headers: CHARGER_HEADERS,
    sample: [
      "85044090",
      "Exide Industries",
      "4500",
      "18",
      "12",
      "2026-01-10",
      "2031-01-10",
      "INV-EXD-0421",
      "2026-01-15",
      "Warehouse A",
      "new",
      "CHR-EXD-0001",
      "true",
      "51",
    ],
  },
  paraphernalia: {
    type: "paraphernalia",
    description:
      "Count-based accessories (helmets, cables, brackets). One row per batch.",
    headers: PARAPHERNALIA_HEADERS,
    sample: [
      "39269099",
      "Exide Industries",
      "350",
      "18",
      "0",
      "2026-01-10",
      "2031-01-10",
      "INV-EXD-0421",
      "2026-01-15",
      "Warehouse A",
      "Cable",
      "5m XLPE",
      "100",
    ],
  },
};

export function buildCsvContent(template: CsvTemplate): string {
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    template.headers.map(escape).join(","),
    template.sample.map(escape).join(","),
  ].join("\n");
}
