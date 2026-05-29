/**
 * Link an nbfc row to its tenant (sets nbfc.tenant_id) so the competitive-
 * routing fan-out can create Acquire assignments for it. Guarded: only updates
 * when the current tenant_id IS NULL (won't clobber an existing binding).
 *
 *   node scripts/repoint-nbfc-tenant.mjs <nbfcId> <tenantId>
 *
 * e.g.  node scripts/repoint-nbfc-tenant.mjs 102 b02c0ab4-3618-4281-b893-fc69e6799d25
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (process.env.DATABASE_URL ||
  readFileSync(join(root, ".env.local"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)[1]).replace(/^["']|["']$/g, "");

const [nbfcIdRaw, tenantId] = process.argv.slice(2);
const nbfcId = Number(nbfcIdRaw);
if (!Number.isFinite(nbfcId) || !tenantId) {
  console.error("Usage: node scripts/repoint-nbfc-tenant.mjs <nbfcId> <tenantId>");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

const [tenant] = await sql`SELECT id, display_name FROM nbfc_tenants WHERE id = ${tenantId} LIMIT 1`;
if (!tenant) { console.error(`Tenant ${tenantId} not found`); await sql.end(); process.exit(1); }

const [before] = await sql`SELECT id, short_name, tenant_id FROM nbfc WHERE id = ${nbfcId} LIMIT 1`;
if (!before) { console.error(`nbfc id=${nbfcId} not found`); await sql.end(); process.exit(1); }
if (before.tenant_id && before.tenant_id !== tenantId) {
  console.error(`nbfc id=${nbfcId} already bound to a DIFFERENT tenant (${before.tenant_id}). Refusing to clobber. Resolve manually.`);
  await sql.end(); process.exit(1);
}

const res = await sql`UPDATE nbfc SET tenant_id = ${tenantId} WHERE id = ${nbfcId} AND tenant_id IS NULL`;
console.log(`Linked nbfc id=${nbfcId} (${before.short_name}) → tenant ${tenant.display_name} (${tenantId}). Rows updated: ${res.count}`);
await sql.end({ timeout: 5 });
