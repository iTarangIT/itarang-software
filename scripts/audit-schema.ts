// Read-only schema audit: does the live database match src/lib/db/schema.ts?
//
// Prints three lists, per table:
//   1. columns declared in schema.ts but MISSING in the DB  → Drizzle names every
//      column in its SELECT/INSERT, so each of these is a runtime
//      "column does not exist" waiting to happen. Fix with an additive migration.
//   2. columns in the DB but NOT in schema.ts                → add them to
//      schema.ts (never drop — migrations are strictly additive).
//   3. type mismatches (canonicalised: varchar(255) ≡ character varying, etc.)
// plus whole tables missing on either side.
//
// Every ticket that adds a column should re-run this against sandbox (db-1) and
// prod (db-2) before and after applying its migration. Exit code is 1 when any
// difference is found, so it can gate CI.
//
//   node --import tsx --env-file=.env.local scripts/audit-schema.ts
//   node --import tsx --env-file=.env.local scripts/audit-schema.ts --csv columns.csv
//   node --import tsx --env-file=.env.local scripts/audit-schema.ts --sql   # + draft ADD COLUMN lines
//   node --import tsx --env-file=.env.local scripts/audit-schema.ts --json  # machine-readable
//
// --csv takes the output of this query (Supabase / DBeaver "export as CSV"):
//   SELECT table_name, column_name, data_type, udt_name
//   FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2;
// (udt_name is optional but needed to resolve ARRAY / USER-DEFINED types.)
// Without --csv the same query runs live against DATABASE_URL — SELECTs only.

import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../src/lib/db/schema";
import { canonicalType, isDrizzlePgTable } from "./db-helpers/schema-model";

type DbColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string | null;
};

type Col = { type: string; sqlType: string; notNull: boolean; default: string | null };

/**
 * DB-only columns that must NOT be mirrored into schema.ts. Keep this list
 * short and say why — anything else "in DB but not in schema.ts" is drift.
 */
const KNOWN_RETIRED = new Set([
  // Pre-rename name of product_selections.model_number (E-103, Sync Audit
  // G-05). Survives on prod only because migrations never drop; E-251
  // deliberately did not recreate it on sandbox.
  "product_selections.sub_category",
]);

const args = process.argv.slice(2);
const csvPath = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : null;
const wantSql = args.includes("--sql");
const wantJson = args.includes("--json");

/** schema.ts and information_schema spell a few types differently. */
function normalise(raw: string): string {
  let t = raw.toLowerCase().trim();
  let array = false;
  while (t.endsWith("[]")) {
    array = true;
    t = t.slice(0, -2);
  }
  t = canonicalType(t);
  if (t === "serial") t = "int4";
  if (t === "bigserial") t = "int8";
  if (t === "smallserial") t = "int2";
  // udt_name spellings (used for arrays / enums from information_schema)
  const udt: Record<string, string> = {
    int4: "int4", int8: "int8", int2: "int2", float8: "double", float4: "float4",
    bool: "bool", timestamptz: "timestamptz", timestamp: "timestamp",
    varchar: "varchar", bpchar: "char", character: "char",
  };
  t = udt[t] ?? t;
  return array ? `${t}[]` : t;
}

function dbType(row: DbColumnRow): string {
  if (row.data_type === "ARRAY" && row.udt_name)
    return normalise(`${row.udt_name.replace(/^_/, "")}[]`);
  if (row.data_type === "USER-DEFINED" && row.udt_name) return normalise(row.udt_name);
  return normalise(row.data_type);
}

function parseCsv(text: string): DbColumnRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const idx = (name: string) => header.indexOf(name);
  for (const need of ["table_name", "column_name", "data_type"])
    if (idx(need) < 0) throw new Error(`CSV is missing a "${need}" header column`);
  return rows.map((r) => ({
    table_name: r[idx("table_name")],
    column_name: r[idx("column_name")],
    data_type: r[idx("data_type")],
    udt_name: idx("udt_name") >= 0 ? r[idx("udt_name")] || null : null,
  }));
}

async function loadDb(): Promise<{ source: string; rows: DbColumnRow[] }> {
  if (csvPath) return { source: `csv:${csvPath}`, rows: parseCsv(readFileSync(csvPath, "utf8")) };
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (or pass --csv <file>)");
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
  try {
    // Base tables only — views are not something schema.ts should mirror.
    const rows = await sql<DbColumnRow[]>`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY 1, 2
    `;
    return { source: `live:${new URL(url).hostname}${new URL(url).pathname}`, rows: [...rows] };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Some SQL tables are declared by more than one exported object (scraper_runs
// is both `scraperRuns` and `scrapeRuns`). Columns are unioned per SQL table;
// a column declared twice with different types keeps the first and the second
// is still checked, via `extraTypes`.
const extraTypes: { table: string; column: string; type: string }[] = [];

function loadCode(): Map<string, Map<string, Col>> {
  const out = new Map<string, Map<string, Col>>();
  for (const value of Object.values(schema)) {
    if (!isDrizzlePgTable(value)) continue;
    const cfg = getTableConfig(value);
    if (cfg.schema && cfg.schema !== "public") continue;
    const cols = out.get(cfg.name) ?? new Map<string, Col>();
    for (const c of cfg.columns) {
      const seen = cols.get(c.name);
      if (seen) {
        const type = normalise(c.getSQLType());
        if (type !== seen.type) extraTypes.push({ table: cfg.name, column: c.name, type });
        continue;
      }
      let def: string | null = null;
      // Only literal defaults are safe to echo into a draft migration.
      const d = (c as unknown as { default?: unknown }).default;
      if (typeof d === "number" || typeof d === "boolean") def = String(d);
      else if (typeof d === "string") def = `'${d.replace(/'/g, "''")}'`;
      cols.set(c.name, { type: normalise(c.getSQLType()), sqlType: c.getSQLType(), notNull: c.notNull, default: def });
    }
    out.set(cfg.name, cols);
  }
  return out;
}

async function main() {
  const code = loadCode();
  const { source, rows } = await loadDb();

  const db = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!db.has(r.table_name)) db.set(r.table_name, new Map());
    db.get(r.table_name)!.set(r.column_name, dbType(r));
  }

  const report = {
    source,
    tablesMissingInDb: [] as string[],
    tablesMissingInSchema: [] as string[],
    columnsMissingInDb: [] as { table: string; column: string; type: string }[],
    columnsMissingInSchema: [] as { table: string; column: string; type: string }[],
    typeMismatches: [] as { table: string; column: string; schema: string; db: string }[],
  };
  const draftSql: string[] = [];

  for (const [table, cols] of [...code].sort(([a], [b]) => a.localeCompare(b))) {
    const live = db.get(table);
    if (!live) {
      report.tablesMissingInDb.push(table);
      continue;
    }
    for (const [name, col] of cols) {
      const liveType = live.get(name);
      if (liveType === undefined) {
        report.columnsMissingInDb.push({ table, column: name, type: col.sqlType });
        // Nullable unless there's a literal default to fill existing rows with —
        // never SET NOT NULL retroactively on a table that has rows.
        const notNull = col.notNull && col.default !== null ? " NOT NULL" : "";
        const def = col.default !== null ? ` DEFAULT ${col.default}` : "";
        draftSql.push(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${name}" ${col.sqlType}${def}${notNull};`);
      } else if (liveType !== col.type) {
        report.typeMismatches.push({ table, column: name, schema: col.type, db: liveType });
      }
    }
    for (const [name, type] of live)
      if (!cols.has(name) && !KNOWN_RETIRED.has(`${table}.${name}`))
        report.columnsMissingInSchema.push({ table, column: name, type });
  }
  for (const e of extraTypes) {
    const liveType = db.get(e.table)?.get(e.column);
    if (liveType !== undefined && liveType !== e.type)
      report.typeMismatches.push({ table: e.table, column: e.column, schema: e.type, db: liveType });
  }
  for (const table of [...db.keys()].sort())
    if (!code.has(table)) report.tablesMissingInSchema.push(table);

  const total =
    report.tablesMissingInDb.length +
    report.tablesMissingInSchema.length +
    report.columnsMissingInDb.length +
    report.columnsMissingInSchema.length +
    report.typeMismatches.length;

  if (wantJson) {
    console.log(JSON.stringify({ ...report, draftSql }, null, 2));
  } else {
    console.log(`Schema audit — schema.ts vs ${source}`);
    console.log(`${code.size} tables in schema.ts, ${db.size} in DB\n`);
    const section = (title: string, lines: string[]) => {
      if (!lines.length) return;
      console.log(`${title} (${lines.length})`);
      for (const l of lines) console.log(`  ${l}`);
      console.log();
    };
    section("TABLES in schema.ts but MISSING in DB", report.tablesMissingInDb);
    section("COLUMNS in schema.ts but MISSING in DB",
      report.columnsMissingInDb.map((c) => `${c.table}.${c.column}  ${c.type}`));
    section("TYPE MISMATCHES (schema.ts → DB)",
      report.typeMismatches.map((c) => `${c.table}.${c.column}  ${c.schema} → ${c.db}`));
    section("COLUMNS in DB but MISSING in schema.ts",
      report.columnsMissingInSchema.map((c) => `${c.table}.${c.column}  ${c.type}`));
    section("TABLES in DB but MISSING in schema.ts", report.tablesMissingInSchema);
    if (wantSql && draftSql.length) {
      console.log("-- Draft additive SQL for the missing columns (review before use):");
      for (const l of draftSql) console.log(l);
      console.log();
    }
    console.log(total === 0 ? "✓ No differences." : `✗ ${total} difference(s).`);
  }
  process.exitCode = total === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
