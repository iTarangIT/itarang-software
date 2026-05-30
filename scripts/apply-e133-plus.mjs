/**
 * Apply the NBFC Acquire DDL series that never landed on RDS.
 *
 * The earlier apply-nbfc-origination-migrations.mjs runner started at E-134, so
 * E-133 (nbfc_service_config, nbfc_step_owners, the service_config_snapshot
 * column, the role-check guard) was never applied — that is the `relation
 * "nbfc_service_config" does not exist` crash in submit-product-selection.
 *
 * Every file is additive + idempotent, so re-running already-applied ones is a
 * no-op. The E-139 *data backfill* is deliberately excluded (DDL only).
 *
 *   node scripts/apply-e133-plus.mjs
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
  "drizzle/E-133_nbfc_service_config_and_rbac.sql",
  "drizzle/E-134_enach_mandates.sql",
  "drizzle/E-135_video_kyc.sql",
  "drizzle/E-136_field_investigations.sql",
  "drizzle/E-137_nbfc_wallet_charging.sql",
  "drizzle/E-138_manual_handoff.sql",
  // E-139_backfill_nbfc_tenant_binding.sql — DATA backfill, intentionally skipped
  "drizzle/E-140_nbfc_financing_offers.sql",
  "drizzle/E-141_financing_dead_end.sql",
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
  const content = readFileSync(join(root, rel), "utf8");
  process.stdout.write(`[migrate] applying ${rel} ... `);
  try {
    await sql.unsafe(content); // simple query mode → multi-statement + DO blocks
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
