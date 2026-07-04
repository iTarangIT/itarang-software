/**
 * Apply the pending NBFC migrations E-160 → E-163 (all additive + idempotent):
 *   E-160 — wallet funds-provider (iTarang VA + auto-recharge, inflows dedupe)
 *   E-161 — financing-offer CEO approval / deviation columns
 *   E-162 — NBFC custom RBAC (nbfc_users.role_id, nbfc_roles, nbfc_role_permissions)
 *   E-163 — NBFC notification channels
 *
 * Safe to re-run; every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 *   node scripts/apply-pending-e16x.mjs
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

const MIGRATIONS = [
  "drizzle/E-160_nbfc_wallet_funds_provider.sql",
  "drizzle/E-161_financing_offer_ceo_approval.sql",
  "drizzle/E-162_nbfc_custom_rbac.sql",
  "drizzle/E-163_nbfc_notification_channels.sql",
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
try {
  for (const rel of MIGRATIONS) {
    process.stdout.write(`[migrate] applying ${rel} ... `);
    await sql.unsafe(readFileSync(join(root, rel), "utf8"));
    console.log("ok");
  }

  // Verify the object that caused the reported failure, plus the sibling tables.
  const roleId = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nbfc_users' AND column_name = 'role_id'`;
  const roles = await sql`SELECT to_regclass('public.nbfc_roles') AS t`;
  const rolePerms = await sql`SELECT to_regclass('public.nbfc_role_permissions') AS t`;
  console.log("[verify] nbfc_users.role_id:", roleId.length ? "present" : "(MISSING)");
  console.log("[verify] nbfc_roles table:", roles[0]?.t ?? "(missing)");
  console.log("[verify] nbfc_role_permissions table:", rolePerms[0]?.t ?? "(missing)");
} catch (e) {
  failed = true;
  console.log("FAILED");
  console.error(e?.message ?? e);
}
await sql.end({ timeout: 5 });
process.exit(failed ? 1 : 0);
