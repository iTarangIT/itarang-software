import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (process.env.DATABASE_URL ||
  readFileSync(join(root, ".env.local"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)[1]).replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

console.log("\n=== nbfc rows matching 'electro' ===");
console.log(await sql`SELECT id, short_name, legal_name, tenant_id FROM nbfc WHERE legal_name ILIKE '%electro%' OR short_name ILIKE '%electro%'`);

console.log("\n=== nbfc_tenants matching 'electro' ===");
console.log(await sql`SELECT id, slug, display_name, is_active FROM nbfc_tenants WHERE display_name ILIKE '%electro%' OR slug ILIKE '%electro%'`);

console.log("\n=== nbfc_lead_assignments (count + latest 10) ===");
console.log(await sql`SELECT count(*)::int AS total FROM nbfc_lead_assignments`);
console.log(await sql`SELECT lead_id, nbfc_id, tenant_id, status, assigned_at FROM nbfc_lead_assignments ORDER BY assigned_at DESC LIMIT 10`);

console.log("\n=== recent finance product_selections with selected_nbfcs ===");
console.log(await sql`
  SELECT lead_id, payment_mode, selected_nbfcs, submitted_at
  FROM product_selections
  WHERE payment_mode = 'finance' AND selected_nbfcs IS NOT NULL AND selected_nbfcs::text NOT IN ('[]','null')
  ORDER BY created_at DESC LIMIT 10`);

await sql.end({ timeout: 5 });
