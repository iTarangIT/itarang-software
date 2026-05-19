#!/usr/bin/env node
// Idempotent applier for E-113 — NBFC loan-product scheme highlights, active
// cities, and eligibility documents. Adds 8 nullable/default-empty columns to
// nbfc_loan_products plus a GIN index on active_cities. Re-running is a no-op.
//
// Usage:  node scripts/apply_E113_migration.mjs
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
     ADD COLUMN IF NOT EXISTS active_cities jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS processing_fee_owned_rupees integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS processing_fee_rented_rupees integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS health_life_insurance_owned_rupees integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS health_life_insurance_rented_rupees integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS disbursement_tat_hours integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS min_credit_score integer`,
  `ALTER TABLE nbfc_loan_products
     ADD COLUMN IF NOT EXISTS eligibility_documents jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE INDEX IF NOT EXISTS nbfc_loan_products_active_cities_gin
     ON nbfc_loan_products USING GIN (active_cities)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_loan_products'
      AND column_name IN (
        'active_cities','processing_fee_owned_rupees',
        'processing_fee_rented_rupees','health_life_insurance_owned_rupees',
        'health_life_insurance_rented_rupees','disbursement_tat_hours',
        'min_credit_score','eligibility_documents'
      )
    ORDER BY column_name`;
  console.log(
    "nbfc_loan_products E-113 columns:",
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
