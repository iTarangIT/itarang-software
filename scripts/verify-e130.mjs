#!/usr/bin/env node
// Verify E-130 columns landed in the target DB. Reads DATABASE_URL from .env.local.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const raw = await readFile(resolve(process.cwd(), '.env.local'), 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const checks = [
  { table: 'leads', cols: ['resident_status', 'has_health_insurance', 'has_life_insurance'] },
  { table: 'product_selections', cols: ['battery_photo_urls', 'charger_photo_urls', 'selected_nbfcs', 'customer_disclosure_ack'] },
  { table: 'loan_sanctions', cols: ['sanctioned_by_type'] },
  { table: 'nbfc_loan_products', cols: ['credit_bureau'] },
];

let allOk = true;
for (const c of checks) {
  const res = await client.query(
    `SELECT column_name, data_type, column_default
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2)
      ORDER BY column_name`,
    [c.table, c.cols],
  );
  const present = new Set(res.rows.map((r) => r.column_name));
  for (const col of c.cols) {
    if (present.has(col)) {
      const row = res.rows.find((r) => r.column_name === col);
      console.log(`  ✓ ${c.table}.${col}  (${row.data_type}${row.column_default ? `, default=${row.column_default}` : ''})`);
    } else {
      console.log(`  ✗ ${c.table}.${col}  MISSING`);
      allOk = false;
    }
  }
}

const constraints = await client.query(
  `SELECT conname FROM pg_constraint
   WHERE conname IN (
     'leads_resident_status_check',
     'nbfc_loan_products_credit_bureau_check',
     'loan_sanctions_sanctioned_by_type_check'
   )
   ORDER BY conname`,
);
console.log('\nCHECK constraints:');
for (const r of constraints.rows) console.log(`  ✓ ${r.conname}`);

await client.end();
process.exit(allOk && constraints.rows.length === 3 ? 0 : 1);
