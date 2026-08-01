/**
 * Apply a list of E-<n> migration files to one database, in order, atomically.
 *
 * Dry-run by DEFAULT — BEGIN … ROLLBACK, nothing is kept. Pass --apply to commit.
 *
 *   dry run against prod:
 *     node --import tsx --env-file=.env.local scripts/_apply-migrations.ts --prod \
 *       drizzle/E-214_whatsapp_onboarding_operators.sql \
 *       drizzle/E-216_drive_expense_ingestion.sql \
 *       drizzle/E-217_expense_currency_conversion.sql \
 *       drizzle/E-218_expense_buckets.sql
 *
 *   then the same command with --apply
 *
 * Why this exists alongside _dryrun-migration.ts: that one takes a single file
 * and targets whatever DATABASE_URL happens to be. These four have ORDER
 * dependencies (E-217 backfills tables E-216 creates), so validating them one
 * at a time proves nothing about the sequence. All four run in ONE transaction,
 * so a failure in the fourth leaves the database exactly as it started rather
 * than half-migrated — which on prod is the difference between "try again" and
 * "work out by hand what landed".
 *
 * The preflight matters more than it looks. E-214 has no DO $do$/undefined_table
 * guards, so if prod never got the WhatsApp onboarding tables it fails on a
 * plain ALTER TABLE. Better to say so up front than to read a 42P01 out of a
 * rollback.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

// cwd, not import.meta.dirname — tsx compiles this to CJS where that is
// undefined, and the migration paths are already passed relative to the repo
// root, so the two agree.
const ROOT = process.cwd();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PROD = args.includes("--prod");
const FILES = args.filter((a) => !a.startsWith("--"));

type Marker = { label: string; kind: "table" | "column" | "index"; name: string; column?: string };

// Per-file: the PRE-EXISTING tables it ALTERs (a missing one is a hard failure,
// not a skip) and one telltale object that says "already applied".
//
// `requires` lists only tables the file expects to find ALREADY THERE. A table
// created by an earlier file in the same run is not a prerequisite — the whole
// list runs in one transaction, so E-218_security_resolution_chat can ALTER the
// security_findings that E-215 creates a few statements earlier.
const META: Record<string, { requires: string[]; marker: Marker }> = {
  // expense / whatsapp family (main)
  "E-214_whatsapp_onboarding_operators.sql": {
    requires: ["users", "whatsapp_onboarding_sessions", "dealer_onboarding_applications"],
    marker: { label: "E-214", kind: "table", name: "whatsapp_operators" },
  },
  "E-216_drive_expense_ingestion.sql": {
    requires: ["expense_submissions"],
    marker: { label: "E-216", kind: "table", name: "drive_expense_folders" },
  },
  "E-217_expense_currency_conversion.sql": {
    requires: ["expense_submissions"],
    marker: { label: "E-217", kind: "table", name: "fx_rates" },
  },
  "E-218_expense_buckets.sql": {
    requires: ["expense_submissions"],
    marker: { label: "E-218", kind: "column", name: "expense_submissions", column: "bucket" },
  },
  // security family (Rushikesh-claude) — self-contained: E-215 creates every base
  // table the other four touch, and none of them reference an app table, so
  // `requires` is empty for all five. Note these numbers COLLIDE with the expense
  // family above; the key is the full filename, never the number (see
  // drizzle/MIGRATION_CHECKLIST.md).
  "E-215_security_scanner.sql": {
    requires: [],
    marker: { label: "E-215_security_scanner", kind: "table", name: "security_scan_runs" },
  },
  "E-216_security_events.sql": {
    requires: [],
    marker: { label: "E-216_security_events", kind: "table", name: "security_events" },
  },
  "E-217_security_event_types.sql": {
    requires: [],
    // No structural change beyond one index — the index IS the marker.
    marker: { label: "E-217_security_event_types", kind: "index", name: "security_events_type_occurred_idx" },
  },
  "E-218_security_resolution_chat.sql": {
    requires: [],
    marker: { label: "E-218_security_resolution_chat", kind: "table", name: "security_finding_messages" },
  },
  "E-219_security_finding_actions.sql": {
    requires: [],
    marker: { label: "E-219_security_finding_actions", kind: "table", name: "security_finding_actions" },
  },
};

const UNKNOWN = FILES.filter((f) => !META[path.basename(f)]).map((f) => path.basename(f));
const SELECTED = FILES.map((f) => META[path.basename(f)]).filter(Boolean);
const REQUIRED_TABLES = [...new Set(SELECTED.flatMap((m) => m.requires))];
const MARKERS: Marker[] = SELECTED.map((m) => m.marker);

function resolveUrl(): string {
  if (!PROD) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    return url;
  }
  // Prod lives commented-out in .env.local so it can never be picked up by
  // accident — same convention _diag-zoho-orgs.mjs uses.
  const line = fs
    .readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("# DATABASE_URL=") && l.includes("database-2"));
  if (!line) throw new Error("no commented prod DATABASE_URL (database-2) found in .env.local");
  return line.replace(/^#\s*DATABASE_URL=/, "").trim();
}

async function main() {
  if (!FILES.length) {
    console.error("usage: _apply-migrations.ts [--prod] [--apply] <file.sql> [file.sql …]");
    process.exit(1);
  }
  for (const f of FILES) {
    if (!fs.existsSync(f)) {
      console.error(`missing file: ${f}`);
      process.exit(1);
    }
  }

  const url = resolveUrl();
  const host = new URL(url).host;
  console.log(`host  : ${host}`);
  console.log(`mode  : ${APPLY ? "APPLY (COMMIT)" : "DRY RUN (BEGIN … ROLLBACK)"}`);
  console.log(`files : ${FILES.length}\n${FILES.map((f) => `        ${path.basename(f)}`).join("\n")}\n`);
  if (UNKNOWN.length) {
    // Not fatal — the file still runs. But it has no entry in META, so its
    // prerequisites are unchecked and it gets no "already applied?" line.
    console.log(`note  : no preflight metadata for ${UNKNOWN.join(", ")} — running unchecked\n`);
  }

  // Every IF NOT EXISTS that no-ops raises a NOTICE. On a re-run that is dozens
  // of lines burying the one line that matters, so count them instead — a high
  // count IS the "already applied" signal.
  let notices = 0;
  const sql = postgres(url, {
    ssl: { rejectUnauthorized: false },
    max: 1,
    onnotice: () => {
      notices += 1;
    },
  });

  try {
    // ── Preflight ───────────────────────────────────────────────────────────
    const present = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY(${REQUIRED_TABLES})`;
    const have = new Set(present.map((r) => r.table_name));
    console.log("prerequisite tables:");
    let blocked = false;
    for (const t of REQUIRED_TABLES) {
      const ok = have.has(t);
      if (!ok) blocked = true;
      console.log(`  ${ok ? "OK     " : "MISSING"} ${t}`);
    }

    console.log("\nalready applied?");
    for (const m of MARKERS) {
      let exists: boolean;
      if (m.kind === "table") {
        const r = await sql`SELECT 1 FROM information_schema.tables
                             WHERE table_schema='public' AND table_name=${m.name}`;
        exists = r.length > 0;
      } else if (m.kind === "index") {
        const r = await sql`SELECT 1 FROM pg_indexes
                             WHERE schemaname='public' AND indexname=${m.name}`;
        exists = r.length > 0;
      } else {
        const r = await sql`SELECT 1 FROM information_schema.columns
                             WHERE table_schema='public' AND table_name=${m.name}
                               AND column_name=${m.column!}`;
        exists = r.length > 0;
      }
      console.log(`  ${m.label}: ${exists ? "yes (re-run is a no-op)" : "no  — will be created"}`);
    }

    if (blocked) {
      console.error(
        "\nABORT: a table these migrations ALTER does not exist here. E-214 has no\n" +
          "undefined_table guard, so it would fail on a plain ALTER TABLE. Apply the\n" +
          "migration that creates the missing table first.",
      );
      await sql.end();
      process.exit(1);
    }

    // ── Apply ───────────────────────────────────────────────────────────────
    console.log(`\n--- ${APPLY ? "applying" : "dry-running"} ---`);
    let rolledBack = false;
    try {
      await sql.begin(async (tx) => {
        for (const f of FILES) {
          const t0 = Date.now();
          await tx.unsafe(fs.readFileSync(f, "utf8"));
          console.log(`  OK  ${path.basename(f)}  (${Date.now() - t0}ms)`);
        }
        if (!APPLY) {
          rolledBack = true;
          throw new RollbackSignal();
        }
      });
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err;
    }

    console.log(
      `\n${notices} "already exists, skipping" notice(s) — 0 means everything here was new.`,
    );
    if (rolledBack) {
      console.log("ALL FILES APPLIED CLEANLY — rolled back, database unchanged.");
      console.log("Re-run with --apply to commit.");
    } else {
      console.log("COMMITTED.");
    }
    await sql.end();
    process.exit(0);
  } catch (err) {
    const e = err as { message?: string; code?: string; position?: string; where?: string };
    console.error("\nFAILED — transaction rolled back, database unchanged.");
    console.error("  code    :", e.code);
    console.error("  message :", e.message);
    if (e.where) console.error("  where   :", e.where);
    await sql.end();
    process.exit(2);
  }
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

main();
