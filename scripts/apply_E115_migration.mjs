#!/usr/bin/env node
// Idempotent applier for E-115 — cibil_required + max_credit_score on
// nbfc_loan_products, plus a 300-900 range check on max_credit_score.
// Re-running is a no-op.
//
// Usage:  node scripts/apply_E115_migration.mjs
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
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS cibil_required boolean,
     ADD COLUMN IF NOT EXISTS max_credit_score integer`,
  `DO $do$ BEGIN
     ALTER TABLE nbfc_loan_products
       ADD CONSTRAINT nbfc_loan_products_max_credit_score_range
       CHECK (max_credit_score IS NULL OR (max_credit_score BETWEEN 300 AND 900));
   EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: range check exists';
   END; $do$`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_loan_products'
      AND column_name IN ('cibil_required', 'max_credit_score')
    ORDER BY column_name`;
  if (cols.length !== 2) {
    console.error(
      "Expected 2 new columns, found",
      cols.length,
      "— migration failed",
    );
    process.exit(1);
  }
  for (const c of cols) {
    console.log(`nbfc_loan_products.${c.column_name}: ${c.data_type}`);
  }

  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
