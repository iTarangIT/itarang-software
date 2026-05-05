// Per-asset-type CSV templates for the admin bulk inventory upload (BRD Step 4).
// Each template defines the column header order shown in the downloadable CSV
// and a single example row so admins can see the expected format.

export type AssetType = "battery" | "charger" | "paraphernalia";

export const ASSET_TYPES: AssetType[] = ["battery", "charger", "paraphernalia"];

export interface CsvTemplate {
  type: AssetType;
  description: string;
  headers: string[];
  /** First row of `samples` is the canonical example shown in the BRD; the
   *  rest give admins variety (different OEMs, voltages, conditions, batches). */
  samples: string[][];
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
    samples: [
      // Canonical BRD example — Exide 51V / 105Ah, IoT-enabled, new.
      [
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
      // Amaron 60V / 140Ah, IoT-enabled, new — same OEM batch on a different invoice.
      [
        "85076000",
        "Amaron",
        "112000",
        "18",
        "36",
        "2026-02-04",
        "2031-02-04",
        "INV-AMR-1187",
        "2026-02-08",
        "Warehouse A",
        "new",
        "BAT-AMR-0017",
        "true",
        "IMEI352099001428301",
        "BATCH-AMR-FEB",
        "60",
        "140",
      ],
      // Su-Kam 64V / 153Ah — premium spec, IoT-enabled.
      [
        "85076000",
        "Su-Kam Power",
        "138000",
        "18",
        "36",
        "2026-02-22",
        "2031-02-22",
        "INV-SK-2095",
        "2026-02-25",
        "Warehouse B",
        "new",
        "BAT-SK-0033",
        "true",
        "IMEI352099001428450",
        "BATCH-SK-PREM",
        "64",
        "153",
      ],
      // Exide refurbished 51V / 105Ah — no IoT module.
      [
        "85076000",
        "Exide Industries",
        "62000",
        "18",
        "24",
        "2025-09-01",
        "2030-09-01",
        "INV-EXD-9912",
        "2025-09-05",
        "Warehouse A",
        "refurbished",
        "BAT-EXD-RF-0004",
        "true",
        "",
        "BATCH-EXD-RF-Q3",
        "51",
        "105",
      ],
      // Amaron 51V / 140Ah — no IoT.
      [
        "85076000",
        "Amaron",
        "94500",
        "18",
        "36",
        "2026-03-10",
        "2031-03-10",
        "INV-AMR-1340",
        "2026-03-12",
        "Branch 2",
        "new",
        "BAT-AMR-0042",
        "true",
        "",
        "BATCH-AMR-MAR",
        "51",
        "140",
      ],
    ],
  },
  charger: {
    type: "charger",
    description: "Serialized charger units. One row per physical charger.",
    headers: CHARGER_HEADERS,
    samples: [
      // Canonical 51V standard charger, Exide.
      [
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
      // 60V fast charger, Amaron.
      [
        "85044090",
        "Amaron",
        "6800",
        "18",
        "12",
        "2026-02-04",
        "2031-02-04",
        "INV-AMR-1187",
        "2026-02-08",
        "Warehouse A",
        "new",
        "CHR-AMR-FAST-0001",
        "true",
        "60",
      ],
      // 64V Su-Kam premium fast charger.
      [
        "85044090",
        "Su-Kam Power",
        "7900",
        "18",
        "12",
        "2026-02-22",
        "2031-02-22",
        "INV-SK-2095",
        "2026-02-25",
        "Warehouse B",
        "new",
        "CHR-SK-FAST-0017",
        "true",
        "64",
      ],
      // 48V solar-compatible charger.
      [
        "85044090",
        "Su-Kam Power",
        "5400",
        "18",
        "18",
        "2026-01-30",
        "2031-01-30",
        "INV-SK-1880",
        "2026-02-02",
        "Branch 2",
        "new",
        "CHR-SK-SOLAR-0009",
        "true",
        "48",
      ],
      // 51V refurbished standard charger.
      [
        "85044090",
        "Exide Industries",
        "3200",
        "18",
        "12",
        "2025-09-01",
        "2030-09-01",
        "INV-EXD-9912",
        "2025-09-05",
        "Warehouse A",
        "refurbished",
        "CHR-EXD-RF-0004",
        "true",
        "51",
      ],
    ],
  },
  paraphernalia: {
    type: "paraphernalia",
    description:
      "Count-based accessories (helmets, cables, brackets). One row per batch.",
    headers: PARAPHERNALIA_HEADERS,
    samples: [
      // Canonical 5m XLPE cable batch.
      [
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
      // Helmet batch (safety accessory).
      [
        "65061010",
        "Steelbird",
        "850",
        "18",
        "0",
        "2026-02-01",
        "2031-02-01",
        "INV-SB-0211",
        "2026-02-04",
        "Warehouse A",
        "Helmet",
        "Half-face DOT",
        "60",
      ],
      // Mounting bracket.
      [
        "73269099",
        "Local Vendor",
        "120",
        "18",
        "0",
        "2026-02-10",
        "2031-02-10",
        "INV-LV-0034",
        "2026-02-12",
        "Branch 2",
        "Bracket",
        "U-clamp 51V",
        "200",
      ],
      // Anderson connector batch.
      [
        "85366990",
        "Amphenol",
        "75",
        "18",
        "0",
        "2026-02-18",
        "2031-02-18",
        "INV-AMP-0987",
        "2026-02-20",
        "Warehouse A",
        "Connector",
        "Anderson 50A",
        "300",
      ],
      // Tool kit batch.
      [
        "82060010",
        "Local Vendor",
        "1200",
        "18",
        "0",
        "2026-03-01",
        "2031-03-01",
        "INV-LV-0089",
        "2026-03-03",
        "Branch 2",
        "Tool kit",
        "Service kit v2",
        "30",
      ],
    ],
  },
};

export function buildCsvContent(template: CsvTemplate): string {
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [template.headers.map(escape).join(",")];
  for (const row of template.samples) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\n");
}
