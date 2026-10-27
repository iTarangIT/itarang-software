// One-off: apply E-359 (plain-English comments on the tables and views the AI Analyst may
// read) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e359.mjs database-1
//   node scripts/_apply-e359.mjs database-2
//
// Comments only, and only where a table or column has none. Reads that host's URL from
// .env.local (commented or not), never prints it. Applies the file twice (the second pass
// must be a no-op), then counts the comments on a FRESH connection.
//
// Afterwards: press "Refresh" in the AI Analyst's iTarang database source so the agent
// re-reads them.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-359_analyst_table_comments.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const COUNT = (sql) => sql`
  SELECT count(*)::int AS readable,
         count(obj_description(c.oid, 'pg_class'))::int AS described,
         array_agg(c.relname ORDER BY c.relname) FILTER (WHERE obj_description(c.oid, 'pg_class') IS NULL) AS bare
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
     AND has_any_column_privilege('analyst_ro', c.oid, 'SELECT')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`;

const before = postgres(url, opts);
try {
  console.log("before:", (await COUNT(before))[0]);
} finally {
  await before.end();
}

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  console.log("after:", (await COUNT(check))[0]);
} finally {
  await check.end();
}
