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
  // Column indexes (0-based) whose values are dates. Cells in these columns
  // are emitted as ="YYYY-MM-DD" text formulas so Excel doesn't reformat them
  // when opening the CSV. Stripped on parse via unwrapCsvCell().
  dateColumnIndexes: number[];
  // Column indexes (0-based) of plain integer fields (e.g. quantities, star
  // rating). Emitted with an explicit "0" number format.
  integerColumnIndexes: number[];
  // Column indexes (0-based) locked to Text format ("@"). Use for numeric
  // count fields Excel keeps mis-coercing to a date (e.g. oem_warranty_months
  // — typing 6 became 1/6/1900). Text is the only format Excel never
  // date-coerces; the upload validation runs the value through z.coerce.number.
  textColumnIndexes: number[];
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

const PARAPHERNALIA_HEADERS = [
  "item_type_code",
  "category",
  "quantity",
  "unit_cost",
  "gst_percent",
  "invoice_number",
  "invoice_date",
  "supplier",
  "warehouse_location",
];

// Header names whose values must be normalized to YYYY-MM-DD before validation.
// Kept next to dateColumnIndexes so the column-position and field-name views
// stay in lockstep when headers move.
export const DATE_FIELDS_BY_TYPE: Record<AssetType, string[]> = {
  battery: ["sold_date", "oem_warranty_date"],
  charger: ["sold_date", "oem_warranty_date"],
  paraphernalia: ["invoice_date"],
};

export const CSV_TEMPLATES: Record<AssetType, CsvTemplate> = {
  battery: {
    type: "battery",
    description:
      "Serialized battery upload template. model_id must exist in Product Master (active). voltage, capacity, sub_category, chemistry, customer warranty are auto-filled from the master.",
    headers: BATTERY_HEADERS,
    samples: [],
    dateColumnIndexes: [8, 13], // sold_date, oem_warranty_date
    integerColumnIndexes: [6], // star_rating
    textColumnIndexes: [14], // oem_warranty_months
  },
  charger: {
    type: "charger",
    description:
      "Serialized charger upload template. model_id must exist in Product Master (active). output voltage/current and compatible battery models are auto-filled from the master.",
    headers: CHARGER_HEADERS,
    samples: [],
    dateColumnIndexes: [4, 9], // sold_date, oem_warranty_date
    integerColumnIndexes: [], // (none)
    textColumnIndexes: [10], // oem_warranty_months
  },
  paraphernalia: {
    type: "paraphernalia",
    description:
      "Quantity-tracked paraphernalia template. item_type_code must exist in Product Master (active). compatible categories are auto-filled from the master.",
    headers: PARAPHERNALIA_HEADERS,
    samples: [],
    dateColumnIndexes: [6], // invoice_date
    integerColumnIndexes: [2], // quantity
    textColumnIndexes: [], // (none)
  },
};

export function buildCsvContent(template: CsvTemplate): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const dateIdx = new Set(template.dateColumnIndexes);
  const lines = [template.headers.map(escape).join(",")];
  for (const row of template.samples) {
    lines.push(
      row
        .map((cell, i) => {
          if (dateIdx.has(i) && cell) return escape(`="${cell}"`);
          return escape(cell);
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

// Excel-friendly text formula wrap: when a CSV cell contains ="VALUE" Excel
// renders the formula result (the inner text) and skips date auto-conversion.
// On parse, strip the envelope so YYYY-MM-DD validation sees the bare value.
const TEXT_FORMULA_RE = /^="(.*)"$/;
export function unwrapCsvCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(TEXT_FORMULA_RE);
  return m ? m[1] : value;
}
