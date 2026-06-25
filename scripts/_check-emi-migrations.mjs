// Probe whether the EMI-tracker migrations E-171 (emi_schedules columns) and
// E-172 (emi_payment_attempts ledger) are applied to the DB that DATABASE_URL
// currently points at. READ-ONLY — only information_schema + count queries.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function load(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
load(join(ROOT,".env.local"));

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("SET statement_timeout='30s'");

const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log("DB host:", host || "(unknown)");

// --- E-171: new emi_schedules columns ---
const want171 = ["emi_seq","amount","principal_component","interest_component","attempt_count","last_attempt_at","payment_ref","collection_mode"];
const got171 = (await c.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='emi_schedules' AND column_name = ANY($1)`,
  [want171]
)).rows.map(r => r.column_name);
const missing171 = want171.filter(x => !got171.includes(x));
console.log(`\nE-171 emi_schedules columns: ${got171.length}/${want171.length} present`);
if (missing171.length) console.log("  MISSING:", missing171.join(", "));
else console.log("  -> E-171 APPLIED");

// --- E-172: emi_payment_attempts table + idempotency unique index ---
const tbl = (await c.query(`SELECT to_regclass('public.emi_payment_attempts') AS t`)).rows[0].t;
const idx = (await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='emi_payment_attempts_idem_uniq'`)).rows.length > 0;
console.log(`\nE-172 emi_payment_attempts table: ${tbl ? "EXISTS" : "MISSING"}`);
console.log(`E-172 idempotency unique index:  ${idx ? "EXISTS" : "MISSING"}`);
if (tbl && idx) console.log("  -> E-172 APPLIED");

// --- Data sanity: are amounts/emi_seq backfilled? ---
try {
  const s = (await c.query(`SELECT count(*)::int total,
    count(*) FILTER (WHERE amount IS NOT NULL)::int with_amount,
    count(*) FILTER (WHERE emi_seq IS NOT NULL)::int with_seq
    FROM emi_schedules`)).rows[0];
  console.log(`\nemi_schedules: ${s.total} rows | amount set: ${s.with_amount} | emi_seq set: ${s.with_seq}`);
} catch (e) { console.log("\n(backfill check skipped:", e.message, ")"); }

const applied = missing171.length === 0 && tbl && idx;
console.log(`\n==> EMI migrations ${applied ? "FULLY APPLIED on " + host : "NOT fully applied on " + host + " — paste drizzle/E-171_*.sql and E-172_*.sql into the SQL editor"}`);
await c.end();
