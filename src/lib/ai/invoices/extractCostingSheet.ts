/**
 * E-214 — Structured extraction from a costing spreadsheet (.xlsx / .csv /
 * exported Google Sheet).
 *
 * WHY THIS IS NOT `extractInvoice` IN A LOOP:
 *   An invoice is one document with one total, so one vision call per file is
 *   right. A costing sheet is a hundred near-identical rows. Sending each row
 *   to the model would cost a hundred calls, take minutes, and — worse — give
 *   a hundred independent chances to read the same column differently.
 *
 *   So: ONE call that reads the sheet's shape (which column holds the amount,
 *   which the vendor, where the data starts), then every row mapped in plain
 *   deterministic code. The model does the part it is good at (understanding
 *   an unlabelled layout) exactly once; arithmetic and iteration stay in
 *   TypeScript where they are reproducible.
 *
 * THE GRAND-TOTAL TRAP:
 *   Almost every costing sheet ends with a `Total` row. Importing it alongside
 *   the line items double-counts the entire sheet. `looksLikeTotalRow` drops
 *   those, and the verification step for this module is specifically that
 *   SUM(imported rows) equals the sheet's own total.
 */
import { getOpenAI, INVOICE_MODEL } from "./client";
import {
  EXPENSE_DEPARTMENTS,
  EXPENSE_DEPARTMENT_VALUES,
  type ExpenseDepartment,
} from "@/lib/expenses";

export interface CostingSheetRow {
  vendor: string | null;
  amount: number | null;
  date: string | null; // ISO yyyy-mm-dd
  description: string | null;
  department: ExpenseDepartment | null;
  project_tag: string | null;
  currency: string | null;
  /** Stable identity for dedup: `sheet:<name>:row:<1-based row number>`. */
  row_ref: string;
}

export interface CostingSheetResult {
  rows: CostingSheetRow[];
  sheetName: string;
  /** Rows the model's mapping produced no usable amount for. */
  unparsedRows: number;
  /** Non-empty when the row cap kicked in — never drop rows silently. */
  truncatedNote: string | null;
}

/** A costing sheet longer than this is almost certainly not an expense list. */
const MAX_ROWS = 500;

/** How many leading rows the model gets to work out the layout from. */
const PREVIEW_ROWS = 15;

/**
 * One spreadsheet cell as `XLSX.sheet_to_json({ header: 1 })` yields it.
 *
 * `Date` belongs here: the caller reads workbooks with `cellDates: true`, so a
 * date column arrives as real Date objects rather than Excel serial numbers.
 * Both forms still reach `parseSheetDate`, because a CSV parsed the same way
 * gives strings and an xlsx read without the flag gives serials.
 */
type Cell = string | number | boolean | Date | null | undefined;

const JSON_SCHEMA = {
  name: "costing_sheet_layout",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      data_start_row: {
        type: ["integer", "null"],
        description:
          "0-based index of the FIRST row containing real data (i.e. the row after the header).",
      },
      amount_col: {
        type: ["integer", "null"],
        description:
          "0-based column index holding the cost/amount for each line. The single most important field.",
      },
      vendor_col: {
        type: ["integer", "null"],
        description: "0-based column index holding the vendor/supplier/party name.",
      },
      date_col: {
        type: ["integer", "null"],
        description: "0-based column index holding the line's date.",
      },
      description_col: {
        type: ["integer", "null"],
        description:
          "0-based column index holding the item/particular/description of what was bought.",
      },
      department_col: {
        type: ["integer", "null"],
        description:
          "0-based column index holding a department/cost-centre, if the sheet has one.",
      },
      currency: {
        type: ["string", "null"],
        description: "ISO currency code for the amounts, e.g. INR. Null if unclear.",
      },
      sheet_department: {
        type: ["string", "null"],
        enum: [...EXPENSE_DEPARTMENT_VALUES, null],
        description:
          "Best-fit department for the sheet as a whole, used for rows that have no department of their own.",
      },
      sheet_project_tag: {
        type: ["string", "null"],
        description:
          "Concise project tag (2-4 words, Title Case) describing what this sheet covers.",
      },
    },
    required: [
      "data_start_row",
      "amount_col",
      "vendor_col",
      "date_col",
      "description_col",
      "department_col",
      "currency",
      "sheet_department",
      "sheet_project_tag",
    ],
  },
} as const;

interface SheetLayout {
  data_start_row: number | null;
  amount_col: number | null;
  vendor_col: number | null;
  date_col: number | null;
  description_col: number | null;
  department_col: number | null;
  currency: string | null;
  sheet_department: ExpenseDepartment | null;
  sheet_project_tag: string | null;
}

function buildSystemPrompt(existingTags: string[]): string {
  const deptList = EXPENSE_DEPARTMENTS.map((d) => `${d.value} (${d.label})`).join(", ");
  const tagHint =
    existingTags.length > 0
      ? `Existing project tags you should reuse when they match: ${existingTags.join(", ")}.`
      : "There are no existing project tags yet; propose a short, reusable tag.";
  return [
    "You are reading the first rows of a company cost/expense spreadsheet to work out its LAYOUT.",
    "You do not extract the data itself — you only report which 0-based column index holds each field, and which 0-based row the real data starts on.",
    "Column indexes refer to the arrays exactly as given: the first element is index 0.",
    "The amount column is the one holding the money value for each individual line — not a running total, not a quantity, not a unit rate if a line total also exists.",
    `Classify the sheet as a whole into exactly one department from: ${deptList}.`,
    "Also assign a concise project tag (2-4 words, Title Case).",
    tagHint,
    "If the sheet has no column for a field, return null for that field. Do not guess a column you cannot see.",
  ].join(" ");
}

function cellToString(c: Cell): string | null {
  if (c == null) return null;
  const s = String(c).trim();
  return s === "" ? null : s;
}

/**
 * Parse an amount from a spreadsheet cell.
 * Handles "₹1,20,000.50", "1,200", "(500)" (accounting negative), "Rs. 900".
 */
export function parseSheetAmount(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  const raw = cellToString(c);
  if (!raw) return null;

  const negative = /^\(.*\)$/.test(raw);
  // Strip currency symbols, codes and thousands separators; keep digits, sign, point.
  const cleaned = raw
    .replace(/[()]/g, "")
    .replace(/(?:inr|rs\.?|usd)/gi, "")
    .replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Parse a spreadsheet date cell to ISO yyyy-mm-dd.
 *
 * Handles the Excel serial-number form (xlsx stores dates as days since
 * 1899-12-30 when cellDates is off), plus common typed strings. Ambiguous
 * dd/mm vs mm/dd is resolved as dd/mm — this is an Indian company's books.
 */
export function parseSheetDate(c: Cell): string | null {
  if (c == null) return null;

  if (c instanceof Date) {
    return Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10);
  }

  if (typeof c === "number") {
    // Excel serial. Below 1000 it is far more likely a quantity than a date.
    if (!Number.isFinite(c) || c < 1000 || c > 80000) return null;
    const ms = Math.round((c - 25569) * 86400 * 1000); // 25569 = 1970-01-01 as a serial
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const raw = cellToString(c);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isRealDate(+iso[1], +iso[2], +iso[3]) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;

  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (!isRealDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Reject dates JS would silently roll over (2024-02-31 → 2024-03-02). Same
 * trap `parseDob` guards in src/lib/kyc/ocr-extract.ts.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

/**
 * A summary row masquerading as a line item. Importing one double-counts the
 * whole sheet, so this is checked against every cell in the row, not just the
 * first — sheets put "Grand Total" wherever they like.
 */
export function looksLikeTotalRow(row: Cell[], amountCol: number): boolean {
  return row.some((cell, i) => {
    if (i === amountCol) return false;
    const s = cellToString(cell);
    if (!s) return false;
    return /^\s*(grand\s+total|sub\s*-?\s*total|total|net\s+total|sum)\b/i.test(s);
  });
}

/**
 * Extract one expense per data row from a costing spreadsheet.
 *
 * `rows` is the sheet as raw arrays (XLSX `sheet_to_json({ header: 1 })`).
 * Parsing is the caller's job so this module stays free of file-format concerns
 * and is directly unit-testable.
 */
export async function extractCostingSheet(
  rows: Cell[][],
  sheetName: string,
  options: { existingTags?: string[] } = {},
): Promise<CostingSheetResult> {
  const existingTags = options.existingTags ?? [];

  const nonEmpty = rows.filter((r) => r.some((c) => cellToString(c) !== null));
  if (nonEmpty.length === 0) {
    return { rows: [], sheetName, unparsedRows: 0, truncatedNote: null };
  }

  const layout = await readLayout(nonEmpty.slice(0, PREVIEW_ROWS), existingTags);

  if (layout.amount_col == null) {
    throw new Error(
      "Could not identify an amount column in this spreadsheet — no cost lines were imported.",
    );
  }

  const start = layout.data_start_row ?? 1;
  const body = nonEmpty.slice(start);

  const capped = body.slice(0, MAX_ROWS);
  const truncatedNote =
    body.length > MAX_ROWS
      ? `Sheet has ${body.length} data rows; only the first ${MAX_ROWS} were imported.`
      : null;

  const out: CostingSheetRow[] = [];
  let unparsedRows = 0;

  capped.forEach((row, i) => {
    if (looksLikeTotalRow(row, layout.amount_col!)) return;

    const amount = parseSheetAmount(row[layout.amount_col!]);
    if (amount == null || amount <= 0) {
      // A blank or non-numeric amount is a spacer/heading row, not a failure
      // worth flagging individually — count them so the caller can report it.
      unparsedRows += 1;
      return;
    }

    const rowDepartment =
      layout.department_col != null
        ? normaliseDepartment(cellToString(row[layout.department_col]))
        : null;

    out.push({
      vendor: layout.vendor_col != null ? cellToString(row[layout.vendor_col]) : null,
      amount,
      date: layout.date_col != null ? parseSheetDate(row[layout.date_col]) : null,
      description:
        layout.description_col != null ? cellToString(row[layout.description_col]) : null,
      department: rowDepartment ?? layout.sheet_department,
      project_tag: layout.sheet_project_tag,
      currency: layout.currency,
      // +1 for 1-based display, + start so the ref points at the real sheet row.
      row_ref: `sheet:${sheetName}:row:${start + i + 1}`,
    });
  });

  return { rows: out, sheetName, unparsedRows, truncatedNote };
}

function normaliseDepartment(value: string | null): ExpenseDepartment | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const direct = EXPENSE_DEPARTMENT_VALUES.find((d) => d === v);
  if (direct) return direct;
  const byLabel = EXPENSE_DEPARTMENTS.find((d) => d.label.toLowerCase() === v);
  return byLabel ? byLabel.value : null;
}

/** The single model call: read the sheet's shape from its first rows. */
async function readLayout(preview: Cell[][], existingTags: string[]): Promise<SheetLayout> {
  const openai = getOpenAI();
  const rendered = preview
    .map((r, i) => `Row ${i}: ${JSON.stringify(r.map((c) => cellToString(c)))}`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: INVOICE_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
    messages: [
      { role: "system", content: buildSystemPrompt(existingTags) },
      {
        role: "user",
        content: `Here are the first rows of the spreadsheet, as 0-based arrays:\n\n${rendered}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty layout response from model");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned non-JSON spreadsheet layout");
  }

  // Re-validate rather than trusting strict mode — same defensive posture as
  // extractInvoice.ts, and here a bad column index would silently import the
  // wrong column as money.
  const colWidth = Math.max(...preview.map((r) => r.length), 0);
  const col = (key: string): number | null => {
    const v = parsed[key];
    if (typeof v !== "number" || !Number.isInteger(v)) return null;
    return v >= 0 && v < colWidth ? v : null;
  };

  const dept = parsed.sheet_department;
  return {
    data_start_row:
      typeof parsed.data_start_row === "number" &&
      Number.isInteger(parsed.data_start_row) &&
      parsed.data_start_row >= 0
        ? parsed.data_start_row
        : null,
    amount_col: col("amount_col"),
    vendor_col: col("vendor_col"),
    date_col: col("date_col"),
    description_col: col("description_col"),
    department_col: col("department_col"),
    currency: typeof parsed.currency === "string" ? parsed.currency : null,
    sheet_department:
      typeof dept === "string" && EXPENSE_DEPARTMENT_VALUES.includes(dept as ExpenseDepartment)
        ? (dept as ExpenseDepartment)
        : null,
    sheet_project_tag:
      typeof parsed.sheet_project_tag === "string" && parsed.sheet_project_tag.trim()
        ? parsed.sheet_project_tag.trim()
        : null,
  };
}
