/**
 * Applies drizzle/0036_inventory_upload_reports.sql and
 * drizzle/0037_inventory_brd_strict.sql to the database pointed at by
 * DATABASE_URL in .env.local.
 *
 * Both files are idempotent (CREATE TABLE / ADD COLUMN / CREATE INDEX use
 * IF NOT EXISTS), so re-running this script is safe.
 *
 * Run: node scripts/apply-inventory-brd-migrations.mjs
 */
import 'dotenv/config';
import { config } from 'dotenv';
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local', override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const files = [
  'drizzle/0036_inventory_upload_reports.sql',
  'drizzle/0037_inventory_brd_strict.sql',
];

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    const text = fs.readFileSync(abs, 'utf8');
    process.stdout.write(`Applying ${rel} ... `);
    await sql.unsafe(text);
    console.log('ok');
  }

  const [{ count: invCols }] = await sql`
    select count(*)::int as count
    from information_schema.columns
    where table_name = 'inventory'
      and column_name in (
        'inventory_type','sub_category','material_code','iot_enabled',
        'voltage_v','capacity_ah','output_current_a','compatible_models',
        'star_rating','physical_condition','oem_warranty_date',
        'oem_warranty_months','oem_warranty_expiry','oem_warranty_clauses',
        'upload_event_id'
      )
  `;
  const [{ count: reportCols }] = await sql`
    select count(*)::int as count
    from information_schema.columns
    where table_name = 'inventory_upload_reports'
      and column_name in (
        'inventory_type','upload_method','rows_imported','rows_skipped',
        'file_url','report_url'
      )
  `;
  console.log(`Verified inventory columns present: ${invCols}/15`);
  console.log(`Verified inventory_upload_reports columns present: ${reportCols}/6`);
  console.log('Done.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
