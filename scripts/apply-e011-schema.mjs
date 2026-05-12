#!/usr/bin/env node
// Apply E-011 nbfc_status_history table to sandbox DB via direct SQL.
// Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: "require" });

const ddl = `
CREATE TABLE IF NOT EXISTS nbfc_status_history (
  id serial PRIMARY KEY,
  nbfc_id integer NOT NULL REFERENCES nbfc(id),
  from_status varchar(32),
  to_status varchar(32) NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nbfc_status_history_nbfc_id_idx ON nbfc_status_history(nbfc_id);
CREATE INDEX IF NOT EXISTS nbfc_status_history_occurred_at_idx ON nbfc_status_history(occurred_at);
`;

try {
  await sql.unsafe(ddl);
  const rows = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'nbfc_status_history'
    ORDER BY ordinal_position
  `;
  console.log("nbfc_status_history columns:");
  for (const r of rows) console.log(`  ${r.column_name}: ${r.data_type}`);
  console.log("OK");
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
} finally {
  await sql.end();
}
