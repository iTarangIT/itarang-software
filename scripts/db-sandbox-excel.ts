/**
 * Generates a single-workbook Excel inventory of every column in every table
 * in the live sandbox RDS, plus per-table row counts and a preserve/truncate
 * policy column used to drive the sandbox -> production migration.
 *
 * Output: docs/db/sandbox-<YYYY-MM-DD-HHMM>/sandbox-catalog.xlsx
 *   Sheet "columns" — one row per column.
 *   Sheet "tables"  — one row per table.
 *
 * Reads sandbox via DATABASE_URL from .env.local. Strictly read-only.
 */

import dotenv from "dotenv";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import ExcelJS from "exceljs";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { introspect, rowCounts } from "./db-helpers/introspect";

export const PRESERVE_TABLES = new Set<string>([
  "users",
  "accounts",
  "product_categories",
  "products",
]);
export const PRESERVE_PREFIXES = ["scraper_", "scraped_"];

export function policyFor(tableName: string): "preserve" | "truncate" {
  if (PRESERVE_TABLES.has(tableName)) return "preserve";
  for (const prefix of PRESERVE_PREFIXES) {
    if (tableName.startsWith(prefix)) return "preserve";
  }
  return "truncate";
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Run via `npm run db:sandbox-excel` (infisical injects it) or export it manually.");
    process.exit(1);
  }

  console.log("[db:sandbox-excel] introspecting sandbox…");
  const model = await introspect(url, "sandbox");
  const tableNames = Object.keys(model.tables).sort();
  console.log(`[db:sandbox-excel]   ${tableNames.length} tables`);

  console.log("[db:sandbox-excel] counting rows…");
  const counts = await rowCounts(url, tableNames);

  const wb = new ExcelJS.Workbook();
  wb.creator = "scripts/db-sandbox-excel.ts";
  wb.created = new Date();

  const colsSheet = wb.addWorksheet("columns");
  colsSheet.columns = [
    { header: "table", key: "table", width: 38 },
    { header: "column_name", key: "column_name", width: 32 },
    { header: "column_type", key: "column_type", width: 20 },
    { header: "nullable", key: "nullable", width: 10 },
    { header: "is_primary_key", key: "is_primary_key", width: 14 },
    { header: "is_unique_key", key: "is_unique_key", width: 14 },
    { header: "default", key: "default", width: 10 },
    { header: "rows_populated", key: "rows_populated", width: 16 },
    { header: "policy", key: "policy", width: 12 },
  ];
  colsSheet.getRow(1).font = { bold: true };
  colsSheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const t of tableNames) {
    const table = model.tables[t];
    const pk = new Set(table.primaryKey);
    const singleColUniqueIdx = new Set<string>();
    for (const idx of table.indexes) {
      if (idx.unique && idx.columns.length === 1) {
        singleColUniqueIdx.add(idx.columns[0]);
      }
    }
    const policy = policyFor(t);
    const rows = counts[t];
    for (const col of Object.values(table.columns)) {
      colsSheet.addRow({
        table: t,
        column_name: col.name,
        column_type: col.dataType,
        nullable: col.notNull ? "no" : "yes",
        is_primary_key: pk.has(col.name) ? "yes" : "no",
        is_unique_key:
          pk.has(col.name) || singleColUniqueIdx.has(col.name) ? "yes" : "no",
        default: col.hasDefault ? "yes" : "no",
        rows_populated: rows ?? 0,
        policy,
      });
    }
  }
  colsSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: colsSheet.columns.length },
  };

  const tablesSheet = wb.addWorksheet("tables");
  tablesSheet.columns = [
    { header: "table", key: "table", width: 38 },
    { header: "rows_populated", key: "rows_populated", width: 16 },
    { header: "column_count", key: "column_count", width: 14 },
    { header: "primary_key", key: "primary_key", width: 32 },
    { header: "policy", key: "policy", width: 12 },
  ];
  tablesSheet.getRow(1).font = { bold: true };
  tablesSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const t of tableNames) {
    const table = model.tables[t];
    tablesSheet.addRow({
      table: t,
      rows_populated: counts[t] ?? 0,
      column_count: Object.keys(table.columns).length,
      primary_key: table.primaryKey.join(", "),
      policy: policyFor(t),
    });
  }
  tablesSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: tablesSheet.columns.length },
  };

  const outDir = path.resolve(process.cwd(), "docs", "db", `sandbox-${stamp()}`);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "sandbox-catalog.xlsx");
  await wb.xlsx.writeFile(outPath);

  const totalRows = tableNames.reduce((acc, t) => acc + (counts[t] ?? 0), 0);
  const preserveCount = tableNames.filter((t) => policyFor(t) === "preserve").length;

  console.log(`[db:sandbox-excel] done`);
  console.log(`  tables          : ${tableNames.length}`);
  console.log(`  preserve / trunc: ${preserveCount} / ${tableNames.length - preserveCount}`);
  console.log(`  total rows      : ${totalRows.toLocaleString()}`);
  console.log(`  output          : ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
