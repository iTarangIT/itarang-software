#!/usr/bin/env node
// Idempotent applier for E-114 — active_locations jsonb on nbfc_loan_products,
// plus a GIN index. Replaces the iteration-1 active_cities shape with
// {state, city} pairs. Re-running is a no-op.
//
// Usage:  node scripts/apply_E114_migration.mjs
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
     ADD COLUMN IF NOT EXISTS active_locations jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE INDEX IF NOT EXISTS nbfc_loan_products_active_locations_gin
     ON nbfc_loan_products USING GIN (active_locations)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }

  const cols = await sql`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_loan_products'
      AND column_name = 'active_locations'`;
  if (cols.length === 0) {
    console.error("active_locations column NOT FOUND — migration failed");
    process.exit(1);
  }
  console.log(
    "nbfc_loan_products.active_locations:",
    `${cols[0].data_type}, default ${cols[0].column_default}`,
  );

  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
