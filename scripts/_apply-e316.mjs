// One-off: apply E-316 to the database in DATABASE_URL, twice, then verify on a
// fresh connection. Run with --env-file=.env.local (database-1 = sandbox) or
// --env-file=.env.production (database-2 = prod).
import postgres from "postgres";
import { readFileSync } from "node:fs";
const ddl = readFileSync("drizzle/E-316_feature_requests.sql", "utf8");
const url = process.env.DATABASE_URL;
console.log("target:", new URL(url).host);
for (const pass of [1, 2]) {
  const sql = postgres(url, { max: 1, ssl: "require", onnotice: (n) => console.log("  notice:", n.message) });
  await sql.unsafe(ddl);
  await sql.end();
  console.log(`pass ${pass}: ok`);
}
const v = postgres(url, { max: 1, ssl: "require" });
const tables = await v`
  select table_name, count(*)::int as columns
    from information_schema.columns
   where table_name like 'feature_request%'
   group by 1 order by 1`;
const idx = await v`select indexname from pg_indexes where tablename like 'feature_request%' order by 1`;
const seq = await v`select to_regclass('feature_request_code_seq') as seq`;
console.table(tables);
console.log(idx.map((r) => r.indexname).join("\n"));
console.log("sequence:", seq[0].seq ?? "MISSING");
await v.end();
