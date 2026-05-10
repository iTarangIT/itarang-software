/**
 * Audits a single Postgres database (DB-1 / sandbox) for internal schema
 * redundancies and writes docs/tables/redundancy-audit-<YYYY-MM-DD>.xlsx.
 *
 * Sheets:
 *   1. Summary
 *   2. Orphan tables (in DB but not referenced in src/ or drizzle/)
 *   3. Duplicate columns (same name+type in N≥3 tables)
 *   4. Semantic duplicates (table pairs with high name/column similarity)
 *   5. Redundant indexes (duplicate or prefix indexes per table)
 *
 * Read-only. Connects via DATABASE_URL (set by `infisical run --` in the npm
 * script). Run: `npm run db:redundancy-audit`.
 */

import dotenv from "dotenv";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import * as schema from "../src/lib/db/schema";
import {
  getTableConfig,
  PgTable as PgTableClass,
} from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { introspect, rowCounts } from "./db-helpers/introspect";
import {
  findOrphanTables,
  findDuplicateColumns,
  findSemanticPairs,
  findRedundantIndexes,
  type OrphanRow,
  type DuplicateColumnRow,
  type SemanticPairRow,
  type RedundantIndexRow,
} from "./db-helpers/redundancy-rules";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "docs", "tables");

const SEARCH_DIRS = [
  "src/app/api",
  "src/app/(dashboard)",
  "src/app/(auth)",
  "src/lib",
  "src/types",
  "drizzle",
];

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function listDrizzleTables(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [jsName, value] of Object.entries(schema)) {
    if (is(value, PgTableClass)) {
      const cfg = getTableConfig(value as never);
      out.set(cfg.name, jsName);
    }
  }
  return out;
}

async function gitGrepWord(needle: string, dirs: string[]): Promise<string[]> {
  const args = ["grep", "-l", "--untracked", "-w", "-F", "-e", needle, "--", ...dirs];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    const e = err as { code?: number };
    if (e.code === 1) return [];
    throw err;
  }
}

async function findReferences(
  sqlNames: string[],
  drizzleManifest: Map<string, string>,
): Promise<Map<string, string[]>> {
  const dirs = SEARCH_DIRS.filter((d) => existsSync(path.join(REPO_ROOT, d)));
  const refs = new Map<string, string[]>();
  for (const sqlName of sqlNames) {
    const jsName = drizzleManifest.get(sqlName);
    const sqlHits = await gitGrepWord(sqlName, dirs);
    const jsHits =
      jsName && jsName !== sqlName ? await gitGrepWord(jsName, dirs) : [];
    const combined = Array.from(new Set([...sqlHits, ...jsHits])).sort();
    refs.set(sqlName, combined);
  }
  return refs;
}

function redactHost(url: string | undefined): string {
  if (!url) return "(not set)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}/${u.pathname.slice(1)}`;
  } catch {
    return "(unparseable)";
  }
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE5E7EB" },
  };
}

function autoSize(sheet: ExcelJS.Worksheet) {
  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = Math.min(len, 60);
    });
    col.width = max + 2;
  });
}

function writeSummarySheet(
  wb: ExcelJS.Workbook,
  ctx: {
    dbHost: string;
    timestamp: string;
    tablesScanned: number;
    columnsScanned: number;
    indexesScanned: number;
    orphanCount: number;
    duplicateColumnCount: number;
    semanticPairCount: number;
    redundantIndexCount: number;
  },
) {
  const sheet = wb.addWorksheet("Summary");
  sheet.addRow(["DB-1 schema redundancy audit"]);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow([]);
  const facts: [string, string | number][] = [
    ["Generated at", ctx.timestamp],
    ["Database", ctx.dbHost],
    ["Tables scanned", ctx.tablesScanned],
    ["Columns scanned", ctx.columnsScanned],
    ["Indexes scanned", ctx.indexesScanned],
    ["", ""],
    ["Orphan tables", ctx.orphanCount],
    ["Duplicate column groups (N≥3)", ctx.duplicateColumnCount],
    ["Semantic table pairs flagged", ctx.semanticPairCount],
    ["Redundant index pairs", ctx.redundantIndexCount],
  ];
  for (const [k, v] of facts) sheet.addRow([k, v]);
  sheet.getColumn(1).width = 36;
  sheet.getColumn(2).width = 50;
  sheet.getColumn(1).font = { bold: true };
}

function writeOrphanSheet(wb: ExcelJS.Workbook, rows: OrphanRow[]) {
  const sheet = wb.addWorksheet("Orphan tables");
  sheet.addRow([
    "sql_name",
    "drizzle_export",
    "row_count",
    "ref_count",
    "top_files",
    "verdict",
  ]);
  styleHeader(sheet.getRow(1));
  for (const r of rows) {
    sheet.addRow([
      r.sqlName,
      r.jsName ?? "(not in schema.ts)",
      r.rowCount ?? "—",
      r.refCount,
      r.topFiles.join("\n") || "—",
      r.verdict,
    ]);
  }
  sheet.getColumn(5).alignment = { wrapText: true, vertical: "top" };
  autoSize(sheet);
  sheet.autoFilter = { from: "A1", to: "F1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function writeDuplicateColumnSheet(
  wb: ExcelJS.Workbook,
  rows: DuplicateColumnRow[],
) {
  const sheet = wb.addWorksheet("Duplicate columns");
  sheet.addRow([
    "column_name",
    "data_type",
    "table_count",
    "tables",
    "has_fk_to_common_parent",
  ]);
  styleHeader(sheet.getRow(1));
  for (const r of rows) {
    sheet.addRow([
      r.columnName,
      r.dataType,
      r.tableCount,
      r.tables.join(", "),
      r.hasFkToCommonParent ? "yes" : "no",
    ]);
  }
  sheet.getColumn(4).alignment = { wrapText: true, vertical: "top" };
  autoSize(sheet);
  sheet.autoFilter = { from: "A1", to: "E1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function writeSemanticPairSheet(
  wb: ExcelJS.Workbook,
  rows: SemanticPairRow[],
) {
  const sheet = wb.addWorksheet("Semantic duplicates");
  sheet.addRow([
    "table_a",
    "table_b",
    "name_similarity",
    "column_overlap",
    "shared_columns",
    "unique_to_a",
    "unique_to_b",
    "verdict",
  ]);
  styleHeader(sheet.getRow(1));
  for (const r of rows) {
    sheet.addRow([
      r.tableA,
      r.tableB,
      r.nameSimilarity,
      r.columnOverlap,
      r.sharedColumns,
      r.uniqueToA,
      r.uniqueToB,
      r.verdict,
    ]);
  }
  autoSize(sheet);
  sheet.autoFilter = { from: "A1", to: "H1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function writeRedundantIndexSheet(
  wb: ExcelJS.Workbook,
  rows: RedundantIndexRow[],
) {
  const sheet = wb.addWorksheet("Redundant indexes");
  sheet.addRow([
    "table",
    "index_a",
    "index_a_columns",
    "index_b",
    "index_b_columns",
    "relationship",
    "drop_candidate",
  ]);
  styleHeader(sheet.getRow(1));
  for (const r of rows) {
    sheet.addRow([
      r.table,
      r.indexA,
      r.indexAColumns.join(", "),
      r.indexB,
      r.indexBColumns.join(", "),
      r.relationship,
      r.dropCandidate,
    ]);
  }
  autoSize(sheet);
  sheet.autoFilter = { from: "A1", to: "G1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "[db:redundancy-audit] DATABASE_URL not set. Run via `npm run db:redundancy-audit` (uses infisical).",
    );
    process.exit(1);
  }

  console.log("[db:redundancy-audit] introspecting DB-1 (sandbox)…");
  const model = await introspect(dbUrl, "sandbox");
  const tableNames = Object.keys(model.tables);
  console.log(`[db:redundancy-audit]   ${tableNames.length} tables, scanning…`);

  const drizzleManifest = listDrizzleTables();

  console.log("[db:redundancy-audit] querying row counts…");
  const counts = await rowCounts(dbUrl, tableNames);

  console.log("[db:redundancy-audit] grepping code references…");
  const refs = await findReferences(tableNames, drizzleManifest);

  console.log("[db:redundancy-audit] computing redundancy rules…");
  const orphans = findOrphanTables(model, drizzleManifest, counts, refs);
  const duplicateCols = findDuplicateColumns(model);
  const semanticPairs = findSemanticPairs(model);
  const redundantIndexes = findRedundantIndexes(model);

  let columnsScanned = 0;
  let indexesScanned = 0;
  for (const t of Object.values(model.tables)) {
    columnsScanned += Object.keys(t.columns).length;
    indexesScanned += t.indexes.length;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "db-redundancy-audit";
  wb.created = new Date();

  writeSummarySheet(wb, {
    dbHost: redactHost(dbUrl),
    timestamp: new Date().toISOString(),
    tablesScanned: tableNames.length,
    columnsScanned,
    indexesScanned,
    orphanCount: orphans.filter((o) => o.verdict === "orphan").length,
    duplicateColumnCount: duplicateCols.length,
    semanticPairCount: semanticPairs.length,
    redundantIndexCount: redundantIndexes.length,
  });
  writeOrphanSheet(wb, orphans);
  writeDuplicateColumnSheet(wb, duplicateCols);
  writeSemanticPairSheet(wb, semanticPairs);
  writeRedundantIndexSheet(wb, redundantIndexes);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(
    OUTPUT_DIR,
    `redundancy-audit-${todayStamp()}.xlsx`,
  );
  await wb.xlsx.writeFile(outFile);

  console.log("[db:redundancy-audit] done →", path.relative(REPO_ROOT, outFile));
  console.log(
    `  orphans: ${orphans.filter((o) => o.verdict === "orphan").length}` +
      ` | dup-col groups: ${duplicateCols.length}` +
      ` | semantic pairs: ${semanticPairs.length}` +
      ` | redundant index pairs: ${redundantIndexes.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
