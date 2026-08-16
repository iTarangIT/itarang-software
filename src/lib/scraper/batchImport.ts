import Papa from "papaparse";
import { z } from "zod";
import {
  MAX_CITIES,
  MAX_COMMANDS,
  MAX_JOBS,
  type Pair,
} from "./commandParser";
import { normalizeQuery } from "./chunkedPipeline";

// E-241 — spreadsheet input for the batch scraper.
//
// The client converts .xlsx/.xls to CSV before upload with a lazy
// `await import("xlsx")` (the same trick UploadWizard uses to keep ~400 KB of
// SheetJS out of the main bundle) and posts the CSV text here. The SERVER then
// re-parses and re-validates that text from scratch. The preview the operator
// approved is a courtesy, not a source of truth — the safety property
// src/lib/admin/csvUpload.ts opens with, and the reason a hand-crafted POST
// cannot smuggle a 10,000-row batch past the caps.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = MAX_JOBS;

// The template's three columns, plus the spellings people actually use. Headers
// are lower-cased and any run of non-alphanumerics collapsed to "_" before
// lookup, so "Max Results", "max-results" and "MAX_RESULTS" all land together.
type CanonField = "query" | "city" | "max_results";

const HEADER_ALIASES: Record<string, CanonField> = {
  query: "query",
  command: "query",
  search: "query",
  search_query: "query",
  keyword: "query",
  keywords: "query",
  product: "query",
  city: "city",
  location: "city",
  town: "city",
  district: "city",
  place: "city",
  max_results: "max_results",
  maxresults: "max_results",
  limit: "max_results",
  count: "max_results",
  results: "max_results",
};

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Per-row validation. `max_results` is coerced from a string because a
// spreadsheet cell is always text by the time it reaches CSV, and a blank cell
// means "not set", not zero.
const RowSchema = z.object({
  query: z
    .string()
    .trim()
    .min(2, "query must be at least 2 characters")
    .max(200, "query is too long (max 200 characters)"),
  city: z
    .string()
    .trim()
    .max(100, "city is too long (max 100 characters)")
    .optional()
    .nullable(),
  max_results: z
    .union([z.number(), z.string()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `max_results must be a whole number greater than 0 (got "${v}")`,
        });
        return z.NEVER;
      }
      if (n > 200) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "max_results cannot exceed 200",
        });
        return z.NEVER;
      }
      return n;
    }),
});

export interface ParsedRow {
  /** 1-based spreadsheet row number, i.e. data row index + 2 for the header. */
  rowIndex: number;
  status: "valid" | "error";
  data: Pair | null;
  errors: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  validCount: number;
  errorCount: number;
  /** Distinct queries / cities across the valid rows — shown in the summary. */
  queries: number;
  cities: number;
  /** Rows dropped by the MAX_ROWS cap, so truncation is never silent. */
  truncated: number;
  /** Headers that were recognised, for a "we read these columns" line. */
  matchedHeaders: CanonField[];
  /** File-level problems (no header, no query column) that stop the upload. */
  fatal: string | null;
}

// Parse CSV text into validated pairs. Returns per-row status rather than
// throwing on the first bad row: the whole point of the preview table is that
// an operator with one typo in row 40 sees exactly that, fixes it, and
// re-uploads — instead of being told the file is invalid.
export function parseBatchCsv(csvText: string): ParseResult {
  const empty = (fatal: string): ParseResult => ({
    rows: [],
    validCount: 0,
    errorCount: 0,
    queries: 0,
    cities: 0,
    truncated: 0,
    matchedHeaders: [],
    fatal,
  });

  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const rawRows = parsed.data ?? [];
  if (!rawRows.length) {
    return empty(
      "No data rows found. The first row must be a header (query, city, max_results) and at least one row must follow it.",
    );
  }

  // Which of the file's headers we recognised. Everything else is ignored
  // silently — an export with fifteen extra columns should still work.
  const headerMap = new Map<string, CanonField>();
  for (const raw of parsed.meta?.fields ?? []) {
    const canon = HEADER_ALIASES[normalizeHeader(raw)];
    if (canon && !headerMap.has(raw)) headerMap.set(raw, canon);
  }

  const matchedHeaders = [...new Set(headerMap.values())];
  if (!matchedHeaders.includes("query")) {
    return empty(
      `No "query" column found. Expected a header row containing "query" (also accepted: command, search, keyword). Found: ${
        (parsed.meta?.fields ?? []).join(", ") || "nothing"
      }.`,
    );
  }

  const capped = rawRows.slice(0, MAX_ROWS);
  const truncated = rawRows.length - capped.length;

  const rows: ParsedRow[] = [];
  const distinctQueries = new Set<string>();
  const distinctCities = new Set<string>();
  // A (query, city) repeated in the file would enqueue the same scrape twice
  // and bill for it twice, so in-file duplicates are an error the operator can
  // see and remove rather than something quietly collapsed behind their back.
  const seenPairs = new Set<string>();

  capped.forEach((raw, i) => {
    const rowIndex = i + 2; // +1 for 0-based, +1 for the header row

    const picked: Record<string, unknown> = {};
    for (const [rawKey, canon] of headerMap) {
      const v = raw[rawKey];
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s) continue;
      if (picked[canon] === undefined) picked[canon] = s;
    }

    const result = RowSchema.safeParse(picked);
    if (!result.success) {
      rows.push({
        rowIndex,
        status: "error",
        data: null,
        errors: result.error.issues.map((iss) =>
          iss.path.length ? `${iss.path.join(".")}: ${iss.message}` : iss.message,
        ),
      });
      return;
    }

    // Normalised the same way the textarea path normalises, so a query typed
    // into the form and the same query loaded from a sheet produce identical
    // queue rows.
    const query = normalizeQuery(result.data.query).toLowerCase();
    const city = result.data.city ? result.data.city.toLowerCase() : null;
    const key = `${query}|${city ?? ""}`;

    if (seenPairs.has(key)) {
      rows.push({
        rowIndex,
        status: "error",
        data: null,
        errors: [
          `duplicate of an earlier row ("${query}"${city ? ` in ${city}` : ""})`,
        ],
      });
      return;
    }
    seenPairs.add(key);

    distinctQueries.add(query);
    if (city) distinctCities.add(city);

    rows.push({
      rowIndex,
      status: "valid",
      data: { query, city, max_results: result.data.max_results ?? null },
      errors: [],
    });
  });

  // The textarea path caps commands and cities; the sheet path has to say the
  // same thing or an operator could route around the limits through Excel.
  const spread: string[] = [];
  if (distinctQueries.size > MAX_COMMANDS) {
    spread.push(
      `${distinctQueries.size} distinct queries — the limit is ${MAX_COMMANDS} per submission.`,
    );
  }
  if (distinctCities.size > MAX_CITIES) {
    spread.push(
      `${distinctCities.size} distinct cities — the limit is ${MAX_CITIES} per submission.`,
    );
  }

  const validCount = rows.filter((r) => r.status === "valid").length;

  return {
    rows,
    validCount,
    errorCount: rows.length - validCount,
    queries: distinctQueries.size,
    cities: distinctCities.size,
    truncated,
    matchedHeaders,
    fatal: spread.length ? spread.join(" ") : null,
  };
}

export function pairsFromParse(result: ParseResult): Pair[] {
  return result.rows
    .filter((r) => r.status === "valid" && r.data)
    .map((r) => r.data as Pair);
}
