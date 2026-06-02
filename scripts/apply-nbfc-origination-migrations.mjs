/**
 * One-off runner for the NBFC origination migrations (E-134 … E-138).
 *
 * Reads DATABASE_URL from .env.local, then executes each migration file in
 * order. Every file is idempotent (CREATE … IF NOT EXISTS, ADD COLUMN IF NOT
 * EXISTS, DO $do$ … EXCEPTION WHEN duplicate_object), so re-running is a no-op.
 *
 *   node scripts/apply-nbfc-origination-migrations.mjs
 *
 * Prints the target host first so you can confirm you're hitting the DB you
 * intend (it is the shared RDS sandbox/prod — there is no pooler in front).
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// --- load DATABASE_URL from .env.local (standalone scripts don't auto-load it) ---
function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(join(root, ".env.local"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not found in environment or .env.local");
}

const FILES = [
  "drizzle/E-133_nbfc_service_config_and_rbac.sql",
  "drizzle/E-134_enach_mandates.sql",
  "drizzle/E-135_video_kyc.sql",
  "drizzle/E-136_field_investigations.sql",
  "drizzle/E-137_nbfc_wallet_charging.sql",
  "drizzle/E-138_manual_handoff.sql",
  "drizzle/E-139_backfill_nbfc_tenant_binding.sql",
  "drizzle/E-140_nbfc_financing_offers.sql",
  "drizzle/E-141_financing_dead_end.sql",
  "drizzle/E-142_nbfc_users_notification_prefs.sql",
  "drizzle/E-143_nbfc_users_role_normalise.sql",
  "drizzle/E-144_nbfc_loans_drop_loan_application_fk.sql",
];

const connectionString = readDatabaseUrl();
try {
  const u = new URL(connectionString);
  console.log(`[migrate] target: ${u.hostname}${u.pathname}`);
} catch {
  console.log("[migrate] DATABASE_URL set (unparseable URL)");
}

const sql = postgres(connectionString, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

let failed = false;
for (const rel of FILES) {
  const content = readFileSync(join(root, rel), "utf8");
  process.stdout.write(`[migrate] applying ${rel} … `);
  try {
    await sql.unsafe(content); // simple query mode → runs multi-statement files incl. DO blocks
    console.log("ok");
  } catch (e) {
    failed = true;
    console.log("FAILED");
    console.error(e?.message ?? e);
    break; // stop on first failure; fix and re-run (idempotent)
  }
}

await sql.end({ timeout: 5 });
process.exit(failed ? 1 : 0);
