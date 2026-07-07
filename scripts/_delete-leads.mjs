import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
const url = m[1].trim().replace(/^["']|["']$/g, "");

const refs = ["LEAD-20260705-c11c6dfe"];
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  const leadRows = await sql`SELECT id, reference_id FROM leads WHERE id = ANY(${refs})`;
  const ids = leadRows.map(r => r.id);
  console.log("Deleting leads:", leadRows.map(r => `${r.reference_id} (${r.id})`).join(", "));

  // Discover all FK columns pointing at leads
  const fks = await sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'leads'`;

  await sql.begin(async (tx) => {
    // Second-level: co_borrower_documents tied to co_borrowers of these leads
    const cbIds = (await tx`SELECT id FROM co_borrowers WHERE lead_id = ANY(${ids})`).map(r => r.id);
    if (cbIds.length) {
      const d = await tx`DELETE FROM co_borrower_documents WHERE co_borrower_id = ANY(${cbIds})`;
      if (d.count) console.log(`  co_borrower_documents (by co_borrower_id): ${d.count}`);
    }
    // Direct children
    for (const f of fks) {
      const d = await tx`DELETE FROM ${tx(f.table_name)} WHERE ${tx(f.column_name)} = ANY(${ids})`;
      if (d.count) console.log(`  ${f.table_name}.${f.column_name}: ${d.count}`);
    }
    const dl = await tx`DELETE FROM leads WHERE id = ANY(${ids})`;
    console.log(`  leads: ${dl.count}`);
  });

  const remain = await sql`SELECT id FROM leads WHERE id = ANY(${refs})`;
  console.log("\nRemaining after delete:", remain.length ? remain.map(r => r.id).join(", ") : "(none — success)");
} finally {
  await sql.end();
}
