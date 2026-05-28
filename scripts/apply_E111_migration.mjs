#!/usr/bin/env node
// Idempotent applier for E-111 — CEO per-item NBFC correction rounds.
// Creates nbfc_correction_rounds + nbfc_correction_items with their
// uniqueness constraints and indexes. Re-running is a no-op.
//
// Usage:  node scripts/apply_E111_migration.mjs
import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile =
  process.env.NBFC_ENV_FILE || path.resolve(__dirname, "../.env.local");
dotenv.config({ path: envFile });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set; checked", envFile);
  process.exit(1);
}

const sql = postgres(url, {
  ssl: "require",
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nbfc_correction_rounds (
     id              SERIAL PRIMARY KEY,
     nbfc_id         INTEGER NOT NULL REFERENCES nbfc(id) ON DELETE CASCADE,
     round_number    INTEGER NOT NULL,
     status          VARCHAR(20) NOT NULL DEFAULT 'open',
     requested_by    UUID NOT NULL,
     summary_remarks TEXT,
     resolved_at     TIMESTAMPTZ,
     resolved_by     UUID,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT nbfc_correction_rounds_unique UNIQUE (nbfc_id, round_number)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_nbfc_correction_rounds_nbfc_status
     ON nbfc_correction_rounds(nbfc_id, status)`,
  `CREATE TABLE IF NOT EXISTS nbfc_correction_items (
     id                 SERIAL PRIMARY KEY,
     round_id           INTEGER NOT NULL REFERENCES nbfc_correction_rounds(id) ON DELETE CASCADE,
     kind               VARCHAR(24) NOT NULL,
     target_key         VARCHAR(120) NOT NULL,
     target_ref_id      INTEGER,
     previous_value     TEXT,
     previous_file_url  TEXT,
     remark             TEXT,
     resolution_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
     new_value          TEXT,
     new_file_url       TEXT,
     resolved_at        TIMESTAMPTZ,
     resolved_by        UUID,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT nbfc_correction_items_unique UNIQUE (round_id, kind, target_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_nbfc_correction_items_round_status
     ON nbfc_correction_items(round_id, resolution_status)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  // Verify both tables exist with expected columns.
  const roundsCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_correction_rounds'
    ORDER BY column_name`;
  console.log(
    "nbfc_correction_rounds columns:",
    roundsCols.map((c) => c.column_name).join(", ") ||
      "(none — MIGRATION FAILED)",
  );

  const itemsCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_correction_items'
    ORDER BY column_name`;
  console.log(
    "nbfc_correction_items columns:",
    itemsCols.map((c) => c.column_name).join(", ") ||
      "(none — MIGRATION FAILED)",
  );

  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
