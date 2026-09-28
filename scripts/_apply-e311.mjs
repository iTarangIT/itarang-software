// One-off: apply E-311 to the database in DATABASE_URL (sandbox = database-1), twice, then verify.
import postgres from "postgres";
import { readFileSync } from "node:fs";
const ddl = readFileSync("drizzle/E-311_assistant_media_dealer_lead_documents.sql", "utf8");
const host = new URL(process.env.DATABASE_URL).host;
console.log("target:", host);
for (const pass of [1, 2]) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: "require", onnotice: (n) => console.log("  notice:", n.message) });
  await sql.unsafe(ddl);
  await sql.end();
  console.log(`pass ${pass}: ok`);
}
const v = postgres(process.env.DATABASE_URL, { max: 1, ssl: "require" });
const t = await v`select table_name, count(*)::int cols from information_schema.columns where table_name in ('assistant_media','dealer_lead_documents') group by 1 order by 1`;
const i = await v`select indexname from pg_indexes where tablename in ('assistant_media','dealer_lead_documents') order by 1`;
const c = await v`select conname from pg_constraint where conrelid in ('assistant_media'::regclass, 'dealer_lead_documents'::regclass) and contype='c' order by 1`;
console.table(t); console.log(i.map((r) => r.indexname).join(", ")); console.log(c.map((r) => r.conname).join(", "));
await v.end();
