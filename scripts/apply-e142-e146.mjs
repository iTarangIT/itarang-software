/**
 * Apply the NBFC Acquire DDL that landed after the apply-e133-plus.mjs runner
 * (which stopped at E-141). These are the migrations sitting un-applied on RDS:
 *
 *   E-142  nbfc_users.notification_prefs column
 *   E-143  normalise legacy nbfc_users.role values (data, idempotent)
 *   E-144  drop the stale nbfc_loans -> loan_applications FK
 *   E-145  enach_mandates Razorpay handle columns  <-- the Acquire 500
 *   E-146  nbfc_loan_agreements table (§11 agreement track)
 *
 * Every file is additive + idempotent, so re-running already-applied ones is a
 * no-op.
 *
 *   node scripts/apply-e142-e146.mjs
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

const FILES = [
  "drizzle/E-142_nbfc_users_notification_prefs.sql",
  "drizzle/E-143_nbfc_users_role_normalise.sql",
  "drizzle/E-144_nbfc_loans_drop_loan_application_fk.sql",
  "drizzle/E-145_enach_razorpay_fields.sql",
  "drizzle/E-146_nbfc_loan_agreements.sql",
];

const connectionString = readDatabaseUrl();
try {
  const u = new URL(connectionString);
  console.log(`[migrate] target: ${u.hostname}${u.pathname}`);
} catch {
  console.log("[migrate] DATABASE_URL set (unparseable URL)");
}

const sql = postgres(connectionString, { ssl: "require", prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });

let failed = false;
for (const rel of FILES) {
  process.stdout.write(`[migrate] applying ${rel} ... `);
  try {
    await sql.unsafe(readFileSync(join(root, rel), "utf8"));
    console.log("ok");
  } catch (e) {
    failed = true;
    console.log("FAILED");
    console.error(e?.message ?? e);
    break;
  }
}

await sql.end({ timeout: 5 });
process.exit(failed ? 1 : 0);
