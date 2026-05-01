#!/usr/bin/env node
/**
 * E-035 — Apply schema additions directly via postgres-js.
 *
 *   ALTER loan_sanctions ADD recovery_flagged_at, recovery_reason
 *   CREATE TABLE nbfc_borrower_actions
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
  // ALTER loan_sanctions: add recovery_flagged_at, recovery_reason (idempotent)
  `ALTER TABLE loan_sanctions
     ADD COLUMN IF NOT EXISTS recovery_flagged_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS recovery_reason TEXT`,

  // nbfc_borrower_actions
  `CREATE TABLE IF NOT EXISTS nbfc_borrower_actions (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     tenant_id UUID NOT NULL,
     loan_sanction_id VARCHAR(255) NOT NULL,
     action_type VARCHAR(64) NOT NULL,
     status VARCHAR(32) NOT NULL,
     requested_by UUID,
     payload JSONB,
     created_at TIMESTAMPTZ DEFAULT now() NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS nbfc_borrower_actions_tenant_idx ON nbfc_borrower_actions(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS nbfc_borrower_actions_loan_idx ON nbfc_borrower_actions(loan_sanction_id)`,
  `CREATE INDEX IF NOT EXISTS nbfc_borrower_actions_action_type_idx ON nbfc_borrower_actions(action_type)`,
];

try {
  for (const stmt of STATEMENTS) {
    process.stdout.write(`-> ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...\n`);
    await sql.unsafe(stmt);
  }

  // Verify
  const lsCols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'loan_sanctions'
       AND column_name IN ('recovery_flagged_at','recovery_reason')`;
  const tbl = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_name = 'nbfc_borrower_actions'`;
  console.log('loan_sanctions new cols:', lsCols.map((r) => r.column_name));
  console.log('nbfc_borrower_actions exists:', tbl.length === 1);
  if (lsCols.length !== 2 || tbl.length !== 1) {
    console.error('VERIFY FAILED');
    process.exit(3);
  }
  console.log('OK');
} finally {
  await sql.end({ timeout: 5 });
}
