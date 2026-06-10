/**
 * Apply E-160 — NBFC wallet funds-provider (§16.4) + idempotency (§16.3):
 * iTarang Virtual Account + auto-recharge mandate columns on nbfc_wallets, the
 * nbfc_wallet_inflows dedupe table, and provider_event_id on the ledger.
 * Strictly additive + idempotent; safe to re-run.
 *
 *   node scripts/apply-e160.mjs
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(join(root, ".env.local"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not found in environment or .env.local");
}

const rel = "drizzle/E-160_nbfc_wallet_funds_provider.sql";
const connectionString = readDatabaseUrl();
try {
  const u = new URL(connectionString);
  console.log(`[migrate] target: ${u.hostname}${u.pathname}`);
} catch {
  console.log("[migrate] DATABASE_URL set (unparseable URL)");
}

const sql = postgres(connectionString, { ssl: "require", prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
let failed = false;
try {
  process.stdout.write(`[migrate] applying ${rel} ... `);
  await sql.unsafe(readFileSync(join(root, rel), "utf8"));
  console.log("ok");

  // Verify the new objects exist.
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'nbfc_wallets'
      AND column_name IN ('va_provider_account_id','auto_nach_status','auto_nach_last_fired_at')
    ORDER BY column_name`;
  const tbl = await sql`SELECT to_regclass('public.nbfc_wallet_inflows') AS t`;
  const led = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nbfc_wallet_ledger' AND column_name = 'provider_event_id'`;
  console.log("[verify] nbfc_wallets new cols:", cols.map((r) => r.column_name).join(", ") || "(none)");
  console.log("[verify] nbfc_wallet_inflows table:", tbl[0]?.t ?? "(missing)");
  console.log("[verify] ledger.provider_event_id:", led.length ? "present" : "(missing)");
} catch (e) {
  failed = true;
  console.log("FAILED");
  console.error(e?.message ?? e);
}
await sql.end({ timeout: 5 });
process.exit(failed ? 1 : 0);
