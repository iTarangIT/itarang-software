#!/usr/bin/env node
// Idempotent applier for E-109 (nbfc_lsp_agreement_signers child table) and
// E-110 (agreement_template_url + agreement_template_size on
// nbfc_lsp_agreements). Uses the same DATABASE_URL the dev server reads
// from .env.local so both target the identical DB.
//
// Usage:  node scripts/apply_E109_E110_migration.mjs
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
  // E-109 — N-signer child table
  `CREATE TABLE IF NOT EXISTS nbfc_lsp_agreement_signers (
     id                     SERIAL PRIMARY KEY,
     nbfc_lsp_agreement_id  INTEGER NOT NULL REFERENCES nbfc_lsp_agreements(id),
     signer_order           INTEGER NOT NULL,
     party                  VARCHAR(20) NOT NULL,
     full_name              VARCHAR(200) NOT NULL,
     email                  VARCHAR(200) NOT NULL,
     designation            VARCHAR(120) NOT NULL,
     identity_document_url  TEXT NOT NULL,
     identity_document_size INTEGER,
     created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_nbfc_lsp_agreement_signers_agreement
     ON nbfc_lsp_agreement_signers(nbfc_lsp_agreement_id, signer_order)`,

  // E-110 — agreement template URL + size on the parent
  `ALTER TABLE nbfc_lsp_agreements
     ADD COLUMN IF NOT EXISTS agreement_template_url TEXT`,
  `ALTER TABLE nbfc_lsp_agreements
     ADD COLUMN IF NOT EXISTS agreement_template_size INTEGER`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  // Verify
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_lsp_agreements'
      AND column_name IN ('agreement_template_url','agreement_template_size')
    ORDER BY column_name`;
  console.log(
    "nbfc_lsp_agreements columns:",
    cols.map((c) => c.column_name).join(", ") || "(none — MIGRATION FAILED)",
  );

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'nbfc_lsp_agreement_signers'`;
  console.log(
    "Child table:",
    tables.length ? "nbfc_lsp_agreement_signers" : "(missing — MIGRATION FAILED)",
  );

  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
