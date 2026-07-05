import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const refs = ["#IT-2026-0000022", "#IT-2026-0000043"];
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);

  const rows = await sql`
    SELECT * FROM leads WHERE reference_id = ANY(${refs})`;
  console.log("\nMatched leads:", rows.length);
  for (const r of rows) console.log(JSON.stringify({
    id: r.id, reference_id: r.reference_id, name: r.name ?? r.full_name ?? r.customer_full_name,
    mobile: r.mobile ?? r.phone ?? r.phone_number, status: r.status, dealer_id: r.dealer_id, created_at: r.created_at
  }));

  if (rows.length === 0) { await sql.end(); process.exit(0); }
  const ids = rows.map(r => r.id);

  // Find every table with a column referencing leads (by FK)
  const fks = await sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'leads'`;
  console.log("\nFK references to leads:");
  for (const f of fks) {
    const cnt = await sql`SELECT count(*)::int AS c FROM ${sql(f.table_name)} WHERE ${sql(f.column_name)} = ANY(${ids})`;
    console.log(`  ${f.table_name}.${f.column_name} -> ${cnt[0].c} row(s)`);
  }
} finally {
  await sql.end();
}
