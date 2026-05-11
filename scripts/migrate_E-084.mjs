#!/usr/bin/env node
/**
 * E-084 — Apply schema additions directly via postgres-js.
 *
 *   CREATE TABLE nbfc_loan_restructures
 */
import postgres from 'postgres';
import fs from 'node:fs';

const ENV_FILE = process.env.NBFC_ENV_FILE
  ?? '/Users/apoorvgupta/Desktop/Itarang Files/itarang code/test_main/keys/sandbox.env';

if (!process.env.DATABASE_URL && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL missing'); process.exit(2); }

const sql = postgres(url, { ssl: 'require', prepare: false });

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nbfc_loan_restructures (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     tenant_id UUID NOT NULL REFERENCES nbfc_tenants(id),
     loan_application_id VARCHAR(255) NOT NULL,
     approval_request_id UUID NOT NULL,
     prior_emi_amount NUMERIC(12, 2),
     new_emi_amount NUMERIC(12, 2) NOT NULL,
     prior_tenure_months INTEGER,
     new_tenure_months INTEGER NOT NULL,
     new_emi_due_dom INTEGER NOT NULL,
     executed_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS nbfc_loan_restructures_tenant_loan_idx
     ON nbfc_loan_restructures(tenant_id, loan_application_id)`,
  `CREATE INDEX IF NOT EXISTS nbfc_loan_restructures_approval_idx
     ON nbfc_loan_restructures(approval_request_id)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`-> ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...\n`);
    await sql.unsafe(stmt);
  }
  const tbl = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_name = 'nbfc_loan_restructures'`;
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'nbfc_loan_restructures'
     ORDER BY ordinal_position`;
  console.log('nbfc_loan_restructures exists:', tbl.length === 1);
  console.log('columns:', cols.map((r) => r.column_name));
  if (tbl.length !== 1 || cols.length !== 10) {
    console.error('VERIFY FAILED');
    process.exit(3);
  }
  console.log('OK');
} finally {
  await sql.end({ timeout: 5 });
}
