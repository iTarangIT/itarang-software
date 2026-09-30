// One-off: apply E-315 to the database in DATABASE_URL, twice, then verify on a
// fresh connection. Run with --env-file=.env.local (database-1 = sandbox) or
// --env-file=.env.production (database-2 = prod).
import postgres from "postgres";
import { readFileSync } from "node:fs";
const ddl = readFileSync("drizzle/E-315_campaign_auto_retry.sql", "utf8");
const url = process.env.DATABASE_URL;
console.log("target:", new URL(url).host);
for (const pass of [1, 2]) {
  const sql = postgres(url, { max: 1, ssl: "require", onnotice: (n) => console.log("  notice:", n.message) });
  await sql.unsafe(ddl);
  await sql.end();
  console.log(`pass ${pass}: ok`);
}
const v = postgres(url, { max: 1, ssl: "require" });
const cols = await v`
  select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
   where (table_name = 'dialer_campaigns' and column_name = 'max_retries')
      or (table_name = 'dialer_campaign_leads' and column_name in ('attempt_count','next_attempt_at','attempt_history'))
   order by 1, 2`;
const idx = await v`select indexdef from pg_indexes where indexname = 'idx_dialer_campaign_leads_retry_due'`;
console.table(cols);
console.log(idx[0]?.indexdef ?? "INDEX MISSING");
await v.end();
