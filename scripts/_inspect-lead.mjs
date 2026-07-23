// READ-ONLY: inventory a lead and every table that carries its id in a
// `lead_id` column, plus FK children. No writes.
//   node scripts/_inspect-lead.mjs <lead_id>
import { readFileSync } from "node:fs";
import postgres from "postgres";

const LEAD = process.argv[2];
if (!LEAD) { console.error("usage: node scripts/_inspect-lead.mjs <lead_id>"); process.exit(1); }
const val = (k) => (readFileSync(".env.local", "utf8").match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const sql = postgres(val("DATABASE_URL"), { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(val("DATABASE_URL")).hostname, "\nLead:", LEAD, "\n");
  const lead = await sql`SELECT id, owner_name, mobile, phone, dealer_id, status, payment_method, created_at FROM leads WHERE id = ${LEAD}`;
  if (!lead.length) { console.log("No lead with that id."); process.exit(0); }
  console.log("LEAD:", lead[0]);

  // Every table with a column literally named lead_id, referencing this lead.
  const cols = await sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='lead_id' ORDER BY table_name`;
  console.log("\nTables with a lead_id column — non-zero counts:");
  for (const { table_name } of cols) {
    try {
      const c = await sql`SELECT count(*)::int AS n FROM ${sql(table_name)} WHERE lead_id = ${LEAD}`;
      if (c[0].n) console.log(`  ${table_name}: ${c[0].n}`);
    } catch (e) { console.log(`  ${table_name}: (skip ${e.code})`); }
  }

  // FK children that reference leads via any column.
  const fks = await sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='leads'`;
  console.log("\nDeclared FK children of leads:", fks.map((f) => `${f.table_name}.${f.column_name}`).join(", ") || "(none)");
} finally {
  await sql.end();
}
