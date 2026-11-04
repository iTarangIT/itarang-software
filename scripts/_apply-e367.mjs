// One-off: apply E-367 (lead_route_log — AI-qualified leads routed to the area ASM) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e367.mjs database-1
//   node scripts/_apply-e367.mjs database-2
//
// Additive: one new table + three indexes + a CHECK, not mirrored in schema.ts. Reads that host's URL from
// .env.local (commented or not), never prints it. Applies the file twice (the second
// pass must be a no-op), then re-checks the table and its columns on a FRESH connection.
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

const file = readFileSync("drizzle/E-367_lead_route_log.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

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
  const cols = await check`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lead_route_log'
     ORDER BY ordinal_position`;
  console.table(cols);
  if (cols.length !== 10) throw new Error(`expected 10 lead_route_log columns, found ${cols.length}`);
  const [ix] = await check`
    SELECT count(*)::int AS n FROM pg_indexes
     WHERE tablename = 'lead_route_log'
       AND indexname IN ('lead_route_log_user_rule_idx', 'lead_route_log_lead_idx', 'lead_route_log_created_idx')`;
  if (ix.n !== 3) throw new Error(`expected 3 indexes, found ${ix.n}`);
  const [ck] = await check`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'lead_route_log_rule_check'`;
  if (ck.n !== 1) throw new Error("lead_route_log_rule_check missing");
  console.log("E-367 verified: lead_route_log + 3 indexes + rule CHECK");
} finally {
  await check.end();
}
