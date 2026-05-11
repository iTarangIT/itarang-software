#!/usr/bin/env node
// Direct SQL fallback for E-026 — drizzle-kit push hangs in non-TTY.
// Creates borrower_risk_scores and nbfc_recovery_pipeline if absent.
import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NBFC_ENV_FILE || path.resolve(__dirname, "../../../keys/sandbox.env");
dotenv.config({ path: envFile });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set; checked", envFile);
  process.exit(1);
}

const sql = postgres(url, { ssl: "prefer", max: 1, connect_timeout: 10 });

const STATEMENTS = [
  // E-026 prereq (gap G-03): loan_sanctions needs tenant + lifecycle columns.
  `ALTER TABLE loan_sanctions ADD COLUMN IF NOT EXISTS nbfc_id uuid`,
  `ALTER TABLE loan_sanctions ADD COLUMN IF NOT EXISTS disbursed_at timestamptz`,
  `ALTER TABLE loan_sanctions ADD COLUMN IF NOT EXISTS closed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS loan_sanctions_nbfc_idx ON loan_sanctions (nbfc_id)`,
  `CREATE INDEX IF NOT EXISTS loan_sanctions_status_closed_idx ON loan_sanctions (status, closed_at)`,

  `CREATE TABLE IF NOT EXISTS borrower_risk_scores (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL,
     borrower_id uuid NOT NULL,
     loan_sanction_id uuid NOT NULL,
     cds_score numeric(5,2),
     pci_score numeric(4,3),
     confidence varchar(16),
     computed_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS borrower_risk_scores_tenant_idx ON borrower_risk_scores (tenant_id)`,
  `CREATE INDEX IF NOT EXISTS borrower_risk_scores_borrower_idx ON borrower_risk_scores (borrower_id)`,
  `CREATE INDEX IF NOT EXISTS borrower_risk_scores_loan_sanction_idx ON borrower_risk_scores (loan_sanction_id)`,

  `CREATE TABLE IF NOT EXISTS nbfc_recovery_pipeline (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL,
     battery_serial varchar(64) NOT NULL,
     stage varchar(32) NOT NULL,
     estimated_recovery_value numeric(12,2),
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_tenant_idx ON nbfc_recovery_pipeline (tenant_id)`,
  `CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_stage_idx ON nbfc_recovery_pipeline (stage)`,
  `CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_tenant_stage_idx ON nbfc_recovery_pipeline (tenant_id, stage)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`> ${stmt.slice(0, 80).replace(/\s+/g, " ")}…\n`);
    await sql.unsafe(stmt);
  }
  // Verify
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('borrower_risk_scores','nbfc_recovery_pipeline')
    ORDER BY table_name`;
  console.log("Tables present:", tables.map((t) => t.table_name).join(", "));
  process.exit(0);
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
