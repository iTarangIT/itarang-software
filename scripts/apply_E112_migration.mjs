#!/usr/bin/env node
// Idempotent applier for E-112 — per-signer Digio signing status columns on
// nbfc_lsp_agreement_signers (digio_signer_identifier, signing_status,
// signed_at, signing_url, last_status_event_at) plus the status lookup index.
// Mirrors scripts/apply_E111_migration.mjs. Re-running is a no-op.
//
// Usage:  node scripts/apply_E112_migration.mjs
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
  `ALTER TABLE nbfc_lsp_agreement_signers
     ADD COLUMN IF NOT EXISTS digio_signer_identifier VARCHAR(200)`,
  `ALTER TABLE nbfc_lsp_agreement_signers
     ADD COLUMN IF NOT EXISTS signing_status VARCHAR(32) NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE nbfc_lsp_agreement_signers
     ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ`,
  `ALTER TABLE nbfc_lsp_agreement_signers
     ADD COLUMN IF NOT EXISTS signing_url TEXT`,
  `ALTER TABLE nbfc_lsp_agreement_signers
     ADD COLUMN IF NOT EXISTS last_status_event_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_nbfc_lsp_signers_status
     ON nbfc_lsp_agreement_signers(nbfc_lsp_agreement_id, signing_status)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_lsp_agreement_signers'
      AND column_name IN (
        'digio_signer_identifier','signing_status','signed_at',
        'signing_url','last_status_event_at'
      )
    ORDER BY column_name`;
  console.log(
    "nbfc_lsp_agreement_signers Digio columns:",
    cols.map((c) => c.column_name).join(", ") ||
      "(none — MIGRATION FAILED)",
  );

  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
