#!/usr/bin/env node
// Apply E-092 score-explainability tables to sandbox DB via direct SQL.
// Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: "require" });

const ddl = `
CREATE TABLE IF NOT EXISTS nbfc_score_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_application_id varchar(255) NOT NULL,
  score_type varchar(8) NOT NULL,
  score_value numeric(6, 2) NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  confidence_level varchar(8) NOT NULL,
  confidence_reasons jsonb
);
CREATE INDEX IF NOT EXISTS nbfc_score_runs_loan_idx ON nbfc_score_runs(loan_application_id);
CREATE INDEX IF NOT EXISTS nbfc_score_runs_loan_type_idx ON nbfc_score_runs(loan_application_id, score_type);
CREATE INDEX IF NOT EXISTS nbfc_score_runs_computed_at_idx ON nbfc_score_runs(computed_at);

CREATE TABLE IF NOT EXISTS nbfc_score_input_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  score_run_id uuid NOT NULL,
  row_index integer NOT NULL,
  due_date timestamptz,
  amount numeric(12, 2),
  status varchar(24),
  days_late integer,
  contribution numeric(6, 2)
);
CREATE INDEX IF NOT EXISTS nbfc_score_input_snapshots_run_idx ON nbfc_score_input_snapshots(score_run_id);
CREATE INDEX IF NOT EXISTS nbfc_score_input_snapshots_run_row_idx ON nbfc_score_input_snapshots(score_run_id, row_index);
`;

try {
  await sql.unsafe(ddl);
  for (const t of ["nbfc_score_runs", "nbfc_score_input_snapshots"]) {
    const rows = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${t}
      ORDER BY ordinal_position
    `;
    console.log(`${t} columns:`);
    for (const r of rows) console.log(`  ${r.column_name}: ${r.data_type}`);
  }
  console.log("OK");
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
} finally {
  await sql.end();
}
