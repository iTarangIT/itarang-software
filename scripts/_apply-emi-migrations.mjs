// Apply the EMI-tracker migrations E-171 + E-172 to the DB that DATABASE_URL
// currently points at. Both files are additive + idempotent (ADD COLUMN IF NOT
// EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) so re-running
// is a no-op. This is the programmatic equivalent of pasting them into the
// Supabase SQL editor — NOT db:push (no diffing, no drops).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function load(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
load(join(ROOT,".env.local"));

const FILES = [
  "drizzle/E-171_emi_tracker_columns.sql",
  "drizzle/E-172_emi_payment_attempts.sql",
  "drizzle/E-173_emi_partial_payments.sql",
];

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log("Applying EMI migrations to:", host, "\n");

for (const rel of FILES) {
  const sql = readFileSync(join(ROOT, rel), "utf8");
  process.stdout.write(`-> ${rel} ... `);
  try {
    await c.query(sql);            // simple-query protocol runs all statements in the file
    console.log("OK");
  } catch (e) {
    console.log("FAILED");
    console.error("   ", e.message);
    await c.end();
    process.exit(1);
  }
}

// Verify post-state.
const want = ["emi_seq","amount","attempt_count","last_attempt_at","payment_ref","collection_mode"];
const got = (await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='emi_schedules' AND column_name = ANY($1)`,
  [want]
)).rows.map(r => r.column_name);
const tbl = (await c.query(`SELECT to_regclass('public.emi_payment_attempts') AS t`)).rows[0].t;
const s = (await c.query(`SELECT count(*)::int total, count(*) FILTER (WHERE amount IS NOT NULL)::int with_amount, count(*) FILTER (WHERE emi_seq IS NOT NULL)::int with_seq FROM emi_schedules`)).rows[0];

console.log(`\nemi_schedules new cols: ${got.length}/${want.length} | emi_payment_attempts: ${tbl ? "EXISTS" : "MISSING"}`);
console.log(`backfill: ${s.total} rows | amount set: ${s.with_amount} | emi_seq set: ${s.with_seq}`);
console.log(`\n==> Done on ${host}. Reload /nbfc/emi-tracker.`);
await c.end();
