/**
 * Generates docs/db/catalog/ — per-table markdown reference + index + .docx.
 * Source of truth: src/lib/db/schema.ts via getTableConfig().
 * Usage data: ripgrep over src/app/api, src/app/(dashboard), src/lib.
 * Optional row counts: SELECT count(*) against DATABASE_URL (sandbox).
 */

import dotenv from "dotenv";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import * as schema from "../src/lib/db/schema";
import {
  getTableConfig,
  PgTable as PgTableClass,
} from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { modelFromDrizzleSchema, type TableInfo } from "./db-helpers/schema-model";
import { rowCounts } from "./db-helpers/introspect";
import {
  h1,
  h2,
  h3,
  h4,
  p,
  bullet,
  simpleTable,
  spacer,
  note,
  writeDocx,
} from "./db-helpers/render-docx";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(REPO_ROOT, "docs", "db", "catalog");
const TABLES_DIR = path.join(CATALOG_DIR, "tables");

const SEARCH_BUCKETS: Array<{ label: string; globs: string[] }> = [
  {
    label: "API routes",
    globs: ["src/app/api"],
  },
  {
    label: "Pages (App Router)",
    globs: ["src/app/(dashboard)", "src/app/(auth)"],
  },
  {
    label: "Library / services",
    globs: ["src/lib"],
  },
];

type TableEntry = {
  jsName: string;
  sqlName: string;
  table: TableInfo;
  references: Record<string, string[]>;
  rowCount: number | null;
  primarySurface: string | null;
};

function listDrizzleTables(): Array<{ jsName: string; sqlName: string }> {
  const out: Array<{ jsName: string; sqlName: string }> = [];
  for (const [jsName, value] of Object.entries(schema)) {
    if (is(value, PgTableClass)) {
      const cfg = getTableConfig(value as never);
      out.push({ jsName, sqlName: cfg.name });
    }
  }
  return out.sort((a, b) => a.sqlName.localeCompare(b.sqlName));
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
      .filter(Boolean)
      .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
  } catch (err) {
    const e = err as { code?: number };
    if (e.code === 1) return [];
    throw err;
  }
}

async function findReferences(
  jsName: string,
  sqlName: string,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const bucket of SEARCH_BUCKETS) {
    const dirs = bucket.globs.filter((g) => existsSync(path.join(REPO_ROOT, g)));
    if (!dirs.length) {
      out[bucket.label] = [];
      continue;
    }
    const jsHits = await gitGrepWord(jsName, dirs);
    const sqlHits = jsName === sqlName ? [] : await gitGrepWord(sqlName, dirs);
    const combined = Array.from(new Set([...jsHits, ...sqlHits])).sort();
    out[bucket.label] = combined;
  }
  return out;
}

function inferPrimarySurface(refs: Record<string, string[]>): string | null {
  const apiHits = refs["API routes"] ?? [];
  const pageHits = refs["Pages (App Router)"] ?? [];
  const candidates = [...apiHits, ...pageHits].filter((f) =>
    f.includes("/route.ts") || f.includes("/page.tsx") || f.includes("/page.ts"),
  );
  if (!candidates.length) return null;
  const sorted = candidates.sort((a, b) => a.length - b.length);
  return sorted[0]
    .replace(/^src\/app\//, "/")
    .replace(/\(dashboard\)\//, "")
    .replace(/\(auth\)\//, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\/page\.tsx?$/, "")
    .replace(/\/api\//, "/api/");
}

function tableMarkdown(entry: TableEntry): string {
  const t = entry.table;
  const lines: string[] = [];
  lines.push(`# \`${entry.sqlName}\``);
  lines.push("");
  lines.push(`Drizzle export: \`${entry.jsName}\``);
  if (entry.rowCount !== null) {
    lines.push(`Sandbox row count: \`${entry.rowCount.toLocaleString()}\``);
  }
  if (entry.primarySurface) {
    lines.push(`Primary surface: \`${entry.primarySurface}\``);
  }
  lines.push("");

  lines.push("## Columns");
  lines.push("");
  lines.push("| Column | Type | Nullable | Default |");
  lines.push("| --- | --- | --- | --- |");
  for (const col of Object.values(t.columns)) {
    lines.push(
      `| \`${col.name}\` | \`${col.dataType}\` | ${col.notNull ? "no" : "yes"} | ${col.hasDefault ? "yes" : "—"} |`,
    );
  }
  lines.push("");

  if (t.primaryKey.length) {
    lines.push(`**Primary key:** ${t.primaryKey.map((c) => `\`${c}\``).join(", ")}`);
    lines.push("");
  }

  if (t.foreignKeys.length) {
    lines.push("## Foreign keys");
    lines.push("");
    lines.push("| Constraint | Columns | References | On delete |");
    lines.push("| --- | --- | --- | --- |");
    for (const fk of t.foreignKeys) {
      lines.push(
        `| \`${fk.name}\` | ${fk.columns.map((c) => `\`${c}\``).join(", ")} | \`${fk.refTable}\`(${fk.refColumns.map((c) => `\`${c}\``).join(", ")}) | ${fk.onDelete ?? "—"} |`,
      );
    }
    lines.push("");
  }

  if (t.indexes.length) {
    lines.push("## Indexes");
    lines.push("");
    lines.push("| Name | Columns | Unique |");
    lines.push("| --- | --- | --- |");
    for (const idx of t.indexes) {
      lines.push(
        `| \`${idx.name}\` | ${idx.columns.map((c) => `\`${c}\``).join(", ")} | ${idx.unique ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Referenced by");
  lines.push("");
  let totalRefs = 0;
  for (const bucket of SEARCH_BUCKETS) {
    const files = entry.references[bucket.label] ?? [];
    totalRefs += files.length;
    lines.push(`### ${bucket.label} (${files.length})`);
    lines.push("");
    if (!files.length) {
      lines.push("_No references._");
    } else {
      for (const f of files) lines.push(`- \`${f}\``);
    }
    lines.push("");
  }
  if (totalRefs === 0) {
    lines.push(
      "> **No code references found.** This table may be unused, accessed via raw SQL not captured by the search, or referenced only by name in tests.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

function indexMarkdown(entries: TableEntry[]): string {
  const lines: string[] = [];
  lines.push("# Database catalog");
  lines.push("");
  lines.push(
    `Generated from \`src/lib/db/schema.ts\`. ${entries.length} tables.`,
  );
  lines.push("");
  lines.push("| Table | Drizzle export | Rows (sandbox) | Primary surface |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of entries) {
    const link = `[\`${e.sqlName}\`](./tables/${e.sqlName}.md)`;
    const rows =
      e.rowCount === null ? "—" : e.rowCount.toLocaleString();
    lines.push(
      `| ${link} | \`${e.jsName}\` | ${rows} | ${e.primarySurface ? `\`${e.primarySurface}\`` : "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    "_Run \`npm run db:catalog\` (or \`/db-schema catalog\`) to regenerate this directory._",
  );
  return lines.join("\n");
}

function buildDocxChildren(entries: TableEntry[]) {
  const children = [];
  children.push(h1("Database catalog"));
  children.push(
    note(
      `Generated from src/lib/db/schema.ts — ${entries.length} tables. Sandbox row counts shown when DATABASE_URL is set.`,
    ),
  );
  children.push(spacer());

  children.push(h2("Index"));
  children.push(
    simpleTable(
      ["Table", "Drizzle export", "Rows (sandbox)", "Primary surface"],
      entries.map((e) => [
        e.sqlName,
        e.jsName,
        e.rowCount === null ? "—" : e.rowCount.toLocaleString(),
        e.primarySurface ?? "—",
      ]),
    ),
  );
  children.push(spacer());

  for (const entry of entries) {
    children.push(h2(entry.sqlName));
    if (entry.primarySurface) children.push(p(`Primary surface: ${entry.primarySurface}`));
    if (entry.rowCount !== null) children.push(p(`Rows in sandbox: ${entry.rowCount.toLocaleString()}`));

    children.push(h3("Columns"));
    children.push(
      simpleTable(
        ["Column", "Type", "Nullable", "Default"],
        Object.values(entry.table.columns).map((c) => [
          c.name,
          c.dataType,
          c.notNull ? "no" : "yes",
          c.hasDefault ? "yes" : "—",
        ]),
      ),
    );

    if (entry.table.primaryKey.length) {
      children.push(p(`Primary key: ${entry.table.primaryKey.join(", ")}`));
    }

    if (entry.table.foreignKeys.length) {
      children.push(h3("Foreign keys"));
      children.push(
        simpleTable(
          ["Constraint", "Columns", "References", "On delete"],
          entry.table.foreignKeys.map((fk) => [
            fk.name,
            fk.columns.join(", "),
            `${fk.refTable}(${fk.refColumns.join(", ")})`,
            fk.onDelete ?? "—",
          ]),
        ),
      );
    }

    if (entry.table.indexes.length) {
      children.push(h3("Indexes"));
      children.push(
        simpleTable(
          ["Name", "Columns", "Unique"],
          entry.table.indexes.map((i) => [
            i.name,
            i.columns.join(", "),
            i.unique ? "yes" : "no",
          ]),
        ),
      );
    }

    children.push(h3("Referenced by"));
    let totalRefs = 0;
    for (const bucket of SEARCH_BUCKETS) {
      const files = entry.references[bucket.label] ?? [];
      totalRefs += files.length;
      children.push(h4(`${bucket.label} (${files.length})`));
      if (!files.length) children.push(note("No references."));
      else for (const f of files) children.push(bullet(f));
    }
    if (totalRefs === 0) {
      children.push(
        note(
          "No code references found. May be unused, accessed via raw SQL, or referenced only in tests.",
        ),
      );
    }
    children.push(spacer());
  }

  return children;
}

async function main() {
  console.log("[db:catalog] building schema model from schema.ts…");
  const model = modelFromDrizzleSchema(schema);
  const tables = listDrizzleTables();
  console.log(`[db:catalog]   ${tables.length} tables found`);

  console.log("[db:catalog] scanning code references with ripgrep…");
  const referencesByJsName: Record<string, Record<string, string[]>> = {};
  for (const t of tables) {
    referencesByJsName[t.jsName] = await findReferences(t.jsName, t.sqlName);
  }

  let counts: Record<string, number | null> = {};
  if (process.env.DATABASE_URL) {
    console.log("[db:catalog] querying sandbox row counts…");
    try {
      counts = await rowCounts(
        process.env.DATABASE_URL,
        tables.map((t) => t.sqlName),
      );
    } catch (err) {
      console.warn("[db:catalog]   row count query failed:", err);
    }
  } else {
    console.log("[db:catalog] DATABASE_URL not set — skipping row counts.");
  }

  const entries: TableEntry[] = tables
    .filter((t) => model.tables[t.sqlName])
    .map((t) => {
      const refs = referencesByJsName[t.jsName];
      return {
        jsName: t.jsName,
        sqlName: t.sqlName,
        table: model.tables[t.sqlName],
        references: refs,
        rowCount: counts[t.sqlName] ?? null,
        primarySurface: inferPrimarySurface(refs),
      };
    });

  console.log("[db:catalog] writing markdown…");
  await rm(TABLES_DIR, { recursive: true, force: true });
  await mkdir(TABLES_DIR, { recursive: true });
  for (const entry of entries) {
    const file = path.join(TABLES_DIR, `${entry.sqlName}.md`);
    await writeFile(file, tableMarkdown(entry));
  }
  await writeFile(path.join(CATALOG_DIR, "README.md"), indexMarkdown(entries));

  console.log("[db:catalog] writing catalog.docx…");
  await writeDocx(
    path.join(CATALOG_DIR, "catalog.docx"),
    "Database catalog",
    buildDocxChildren(entries),
  );

  console.log(
    `[db:catalog] done — ${entries.length} tables → docs/db/catalog/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
