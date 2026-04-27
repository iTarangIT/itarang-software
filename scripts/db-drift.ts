/**
 * Generates docs/db/drift/<YYYY-MM-DD-HHMM>/drift-report.docx + summary.json.
 * Runs four diffs:
 *   1. branch vs main schema.ts (git)
 *   2. main schema.ts ↔ sandbox RDS
 *   3. sandbox RDS ↔ production RDS
 *   4. main schema.ts ↔ production RDS
 */

import dotenv from "dotenv";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import {
  modelFromDrizzleSchema,
  type SchemaModel,
} from "./db-helpers/schema-model";
import { introspect } from "./db-helpers/introspect";
import {
  diffSchemas,
  diffSummary,
  type SchemaDiff,
} from "./db-helpers/diff";
import {
  h1,
  h2,
  h3,
  p,
  bullet,
  simpleTable,
  spacer,
  note,
  code,
  writeDocx,
} from "./db-helpers/render-docx";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function readProdUrl(): Promise<string | null> {
  const file = path.join(REPO_ROOT, ".env.production");
  if (!existsSync(file)) return null;
  try {
    const contents = await readFile(file, "utf8");
    const parsed = dotenv.parse(contents);
    return parsed.DATABASE_URL ?? null;
  } catch {
    return null;
  }
}

async function loadCurrentSchemaModel(): Promise<SchemaModel> {
  const schema = await import("../src/lib/db/schema");
  return modelFromDrizzleSchema(
    schema as unknown as Record<string, unknown>,
    "code:branch",
  );
}

async function loadMainSchemaModel(): Promise<SchemaModel | { error: string }> {
  let mainSrc: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", "main:src/lib/db/schema.ts"],
      { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 },
    );
    mainSrc = stdout;
  } catch (err) {
    return { error: `git show main:src/lib/db/schema.ts failed: ${(err as Error).message}` };
  }
  const tmpDir = path.join(REPO_ROOT, ".db-drift-tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `schema-main-${Date.now()}.ts`);
  await writeFile(tmpFile, mainSrc);
  try {
    const mod = await import(tmpFile);
    return modelFromDrizzleSchema(
      mod as unknown as Record<string, unknown>,
      "code:main",
    );
  } catch (err) {
    return { error: `failed to import main schema.ts: ${(err as Error).message}` };
  }
}

async function gitDiffSchemaText(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "main", "--", "src/lib/db/schema.ts"],
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    return `git diff failed: ${(err as Error).message}`;
  }
}

function diffToDocxSection(title: string, diff: SchemaDiff) {
  const children = [];
  children.push(h2(title));
  children.push(p(`Comparing ${diff.leftSource} → ${diff.rightSource}`));
  children.push(p(`Summary: ${diffSummary(diff)}`));
  children.push(spacer());

  if (diff.tablesOnlyInLeft.length) {
    children.push(h3(`Only in ${diff.leftSource} (${diff.tablesOnlyInLeft.length})`));
    for (const t of diff.tablesOnlyInLeft) children.push(bullet(t));
    children.push(spacer());
  }
  if (diff.tablesOnlyInRight.length) {
    children.push(h3(`Only in ${diff.rightSource} (${diff.tablesOnlyInRight.length})`));
    for (const t of diff.tablesOnlyInRight) children.push(bullet(t));
    children.push(spacer());
  }
  if (diff.shapeDiffs.length) {
    children.push(h3(`Shape differences (${diff.shapeDiffs.length})`));
    for (const sd of diff.shapeDiffs) {
      children.push(p(`Table: ${sd.table}`));
      const rows: string[][] = [];
      for (const c of sd.columnsOnlyInLeft) rows.push(["column", c, "only in left", ""]);
      for (const c of sd.columnsOnlyInRight) rows.push(["column", c, "only in right", ""]);
      for (const c of sd.columnChanges)
        rows.push([
          "column",
          c.column,
          c.reason,
          `${c.left?.dataType ?? ""} → ${c.right?.dataType ?? ""} | nn:${c.left?.notNull}→${c.right?.notNull} | def:${c.left?.hasDefault}→${c.right?.hasDefault}`,
        ]);
      if (sd.pkDiff)
        rows.push([
          "primary key",
          "",
          "changed",
          `${sd.pkDiff.left.join(",") || "—"} → ${sd.pkDiff.right.join(",") || "—"}`,
        ]);
      for (const i of sd.indexesOnlyInLeft) rows.push(["index", i, "only in left", ""]);
      for (const i of sd.indexesOnlyInRight) rows.push(["index", i, "only in right", ""]);
      for (const i of sd.indexChanges)
        rows.push([
          "index",
          i.index,
          "changed",
          `${i.left?.columns.join(",") ?? ""} (uniq:${i.left?.unique}) → ${i.right?.columns.join(",") ?? ""} (uniq:${i.right?.unique})`,
        ]);
      for (const f of sd.fksOnlyInLeft) rows.push(["fk", f, "only in left", ""]);
      for (const f of sd.fksOnlyInRight) rows.push(["fk", f, "only in right", ""]);
      for (const f of sd.fkChanges)
        rows.push([
          "fk",
          f.fk,
          "changed",
          `${f.left?.refTable ?? ""}(${f.left?.refColumns.join(",") ?? ""}) on del ${f.left?.onDelete ?? "—"} → ${f.right?.refTable ?? ""}(${f.right?.refColumns.join(",") ?? ""}) on del ${f.right?.onDelete ?? "—"}`,
        ]);
      children.push(simpleTable(["Kind", "Name", "Reason", "Detail"], rows));
      children.push(spacer());
    }
  }
  if (
    !diff.tablesOnlyInLeft.length &&
    !diff.tablesOnlyInRight.length &&
    !diff.shapeDiffs.length
  ) {
    children.push(note("No differences."));
    children.push(spacer());
  }
  return children;
}

async function main() {
  const ts = timestamp();
  const outDir = path.join(REPO_ROOT, "docs", "db", "drift", ts);
  await mkdir(outDir, { recursive: true });
  console.log(`[db:drift] output directory: ${outDir}`);

  const summary: Record<string, unknown> = { generatedAt: ts };

  console.log("[db:drift] Diff 1: branch vs main (git diff)…");
  const branchModel = await loadCurrentSchemaModel();
  const mainOrErr = await loadMainSchemaModel();
  const gitText = await gitDiffSchemaText();
  let diff1Models: SchemaDiff | null = null;
  if ("error" in mainOrErr) {
    console.warn(`[db:drift]   ${mainOrErr.error}`);
    summary.diff1 = { mode: "git-text-only", error: mainOrErr.error, hasChanges: !!gitText };
  } else {
    diff1Models = diffSchemas(mainOrErr, branchModel);
    diff1Models.leftSource = "main schema.ts";
    diff1Models.rightSource = "branch schema.ts";
    summary.diff1 = {
      summary: diffSummary(diff1Models),
      tablesAdded: diff1Models.tablesOnlyInRight,
      tablesRemoved: diff1Models.tablesOnlyInLeft,
      tablesChanged: diff1Models.shapeDiffs.map((s) => s.table),
    };
  }

  const sandboxUrl = process.env.DATABASE_URL ?? null;
  const prodUrl = await readProdUrl();

  let sandboxModel: SchemaModel | null = null;
  let prodModel: SchemaModel | null = null;
  let codeModel: SchemaModel = branchModel;
  if ("error" in mainOrErr) {
    summary.diff2_4_codeBaseline = "branch (main load failed)";
  } else {
    codeModel = mainOrErr;
    summary.diff2_4_codeBaseline = "main";
  }
  codeModel.source = "code";

  if (sandboxUrl) {
    console.log("[db:drift] introspecting sandbox…");
    try {
      sandboxModel = await introspect(sandboxUrl, "sandbox");
    } catch (err) {
      console.warn(`[db:drift]   sandbox introspection failed: ${(err as Error).message}`);
      summary.sandboxError = (err as Error).message;
    }
  } else {
    summary.sandboxError = "DATABASE_URL not set";
  }

  if (prodUrl) {
    console.log("[db:drift] introspecting production…");
    try {
      prodModel = await introspect(prodUrl, "production");
    } catch (err) {
      console.warn(`[db:drift]   prod introspection failed: ${(err as Error).message}`);
      summary.prodError = (err as Error).message;
    }
  } else {
    summary.prodError = ".env.production missing or no DATABASE_URL";
  }

  const diff2 = sandboxModel ? diffSchemas(codeModel, sandboxModel) : null;
  const diff3 =
    sandboxModel && prodModel ? diffSchemas(sandboxModel, prodModel) : null;
  const diff4 = prodModel ? diffSchemas(codeModel, prodModel) : null;

  if (diff2) summary.diff2 = { summary: diffSummary(diff2) };
  if (diff3) summary.diff3 = { summary: diffSummary(diff3) };
  if (diff4) summary.diff4 = { summary: diffSummary(diff4) };

  console.log("[db:drift] rendering drift-report.docx…");
  const children = [];
  children.push(h1("Schema drift report"));
  children.push(note(`Generated ${ts}`));
  children.push(spacer());

  children.push(h2("Summary"));
  const summaryRows: string[][] = [];
  summaryRows.push([
    "Diff 1: branch vs main",
    diff1Models ? diffSummary(diff1Models) : gitText ? "see raw diff below" : "no changes",
  ]);
  summaryRows.push([
    "Diff 2: code vs sandbox",
    diff2 ? diffSummary(diff2) : `skipped (${summary.sandboxError})`,
  ]);
  summaryRows.push([
    "Diff 3: sandbox vs production",
    diff3
      ? diffSummary(diff3)
      : `skipped (${summary.sandboxError ?? ""}${summary.prodError ? ` / ${summary.prodError}` : ""})`,
  ]);
  summaryRows.push([
    "Diff 4: code vs production",
    diff4 ? diffSummary(diff4) : `skipped (${summary.prodError})`,
  ]);
  children.push(simpleTable(["Diff", "Result"], summaryRows));
  children.push(spacer());

  if (diff1Models) {
    children.push(...diffToDocxSection("Diff 1 — branch vs main schema.ts", diff1Models));
  } else {
    children.push(h2("Diff 1 — branch vs main schema.ts (raw git diff)"));
    if (!gitText.trim()) {
      children.push(note("No differences."));
    } else {
      const lines = gitText.split("\n");
      const trimmed = lines.length > 200 ? lines.slice(0, 200).concat(["…(truncated)"]) : lines;
      for (const line of trimmed) children.push(code(line));
    }
    children.push(spacer());
  }

  if (diff2) children.push(...diffToDocxSection("Diff 2 — code vs sandbox", diff2));
  else {
    children.push(h2("Diff 2 — code vs sandbox"));
    children.push(note(`Skipped: ${summary.sandboxError}`));
    children.push(spacer());
  }

  if (diff3) children.push(...diffToDocxSection("Diff 3 — sandbox vs production", diff3));
  else {
    children.push(h2("Diff 3 — sandbox vs production"));
    children.push(
      note(
        `Skipped: ${summary.sandboxError ?? ""}${summary.prodError ? ` / ${summary.prodError}` : ""}`,
      ),
    );
    children.push(spacer());
  }

  if (diff4) children.push(...diffToDocxSection("Diff 4 — code vs production", diff4));
  else {
    children.push(h2("Diff 4 — code vs production"));
    children.push(note(`Skipped: ${summary.prodError}`));
    children.push(spacer());
  }

  await writeDocx(
    path.join(outDir, "drift-report.docx"),
    "Schema drift report",
    children,
  );
  await writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  if (gitText.trim()) {
    await writeFile(path.join(outDir, "branch-vs-main.diff"), gitText);
  }

  console.log(`[db:drift] done → ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
