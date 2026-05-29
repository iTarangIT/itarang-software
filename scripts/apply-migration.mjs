#!/usr/bin/env node
// One-shot migration runner: applies a single SQL file against $DATABASE_URL.
// Used because psql isn't installed locally. Loads .env.local for DATABASE_URL.
// Usage: node scripts/apply-migration.mjs drizzle/E-XXX_*.sql

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

async function loadDotEnvLocal() {
  try {
    const raw = await readFile(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, k, vRaw] = m;
      if (process.env[k]) continue; // process env wins
      // strip optional surrounding quotes
      const v = vRaw.replace(/^["'](.*)["']$/, '$1');
      process.env[k] = v;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/apply-migration.mjs <path-to-sql>');
    process.exit(1);
  }
  await loadDotEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (neither in env nor .env.local)');
    process.exit(1);
  }
  const sql = await readFile(resolve(process.cwd(), file), 'utf8');
  const host = new URL(url).host;
  console.log(`> applying ${file}`);
  console.log(`> target host: ${host}`);

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('> ok — migration applied');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('> failed:', err.message);
    if (err.position) console.error('  position:', err.position);
    if (err.hint) console.error('  hint:', err.hint);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
