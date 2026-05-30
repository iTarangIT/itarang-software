/**
 * Apply E-147 — widen the nbfc_service_config E-NACH handoff CHECK to allow the
 * 'itarang_razorpay' managed-Razorpay mode. Idempotent; safe to re-run.
 *
 *   node scripts/apply-e147.mjs
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

const rel = "drizzle/E-147_nbfc_service_config_enach_handoff_itarang_razorpay.sql";
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
} catch (e) {
  failed = true;
  console.log("FAILED");
  console.error(e?.message ?? e);
}
await sql.end({ timeout: 5 });
process.exit(failed ? 1 : 0);
