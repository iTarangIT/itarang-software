/**
 * One-off: apply drizzle/E-177_loan_calculator.sql to the DATABASE_URL host.
 * Idempotent (the migration uses IF NOT EXISTS / DO guards), so re-running is safe.
 * Run: node --import tsx --env-file=.env.local scripts/apply-calculator-migration.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const host = new URL(connectionString).hostname;
  const sqlText = readFileSync("drizzle/E-177_loan_calculator.sql", "utf8");

  console.log(`Applying E-177_loan_calculator.sql to ${host} …`);
  const sql = postgres(connectionString, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
  try {
    await sql.unsafe(sqlText);
    // Confirm the tables landed.
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'calc_%'
      ORDER BY table_name`;
    console.log(`✅ applied. calc_ tables present (${rows.length}):`);
    for (const r of rows) console.log("   -", r.table_name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ migration failed:", e);
    process.exit(1);
  });
