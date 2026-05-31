// One-off: apply the two additive, idempotent migrations that the sandbox DB
// is missing, which break /dealer-portal/leads/new with
// "Failed to initialize or load your draft."
//
// Root cause: the sandbox deploy workflow ships code but never runs DB
// migrations, so the deployed schema.ts declares `leads` columns (E-130,
// E-141) that don't exist in the sandbox DB. The lead-draft resume query
// (db.select().from(leads)) emits an explicit column list, so the missing
// column 500s.
//
// Safe to re-run: every statement is ADD COLUMN IF NOT EXISTS / guarded DO.
//
// Usage (point at the SANDBOX DB):
//   node scripts/fix-sandbox-leads-drift.mjs
//     -> uses DATABASE_URL from your environment, else the active line in .env.local
//   DATABASE_URL="postgresql://...sandbox-host..." node scripts/fix-sandbox-leads-drift.mjs

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const env = readFileSync(join(root, '.env.local'), 'utf8');
  const line = env.split(/\r?\n/).find((l) => /^DATABASE_URL=/.test(l));
  if (!line) throw new Error('No DATABASE_URL in env or active in .env.local');
  return line.replace(/^DATABASE_URL=/, '').trim();
}

const url = resolveUrl();
const host = url.match(/@([^:/]+)/)?.[1] ?? '(unknown)';
console.log(`\nTarget DB host: ${host}`);
console.log('>>> Confirm this is the SANDBOX database before continuing. <<<\n');

const files = ['E-130_addendum_foundation.sql', 'E-141_financing_dead_end.sql'];
const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, connect_timeout: 15 });

try {
  for (const f of files) {
    const content = readFileSync(join(root, 'drizzle', f), 'utf8');
    console.log(`--- Applying ${f} ---`);
    await sql.unsafe(content);
    console.log(`✓ ${f} applied`);
  }
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'leads'
      AND column_name IN ('resident_status','has_health_insurance','has_life_insurance',
                          'financing_decline_category','financing_unavailable_at')
    ORDER BY column_name`;
  console.log('\nVerified leads columns now present:', rows.map((r) => r.column_name).join(', ') || '(NONE — wrong DB?)');
  console.log('\nDone. Click Retry on /dealer-portal/leads/new — no redeploy needed.');
} catch (e) {
  console.error('\nERROR:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
