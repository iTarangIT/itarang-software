// One-off: apply E-362 (lead_callbacks loop columns — D8 callback loop) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e362.mjs database-1
//   node scripts/_apply-e362.mjs database-2
//
// Additive: six columns + one index on lead_callbacks, not mirrored in schema.ts. Reads that host's URL from
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

const file = readFileSync("drizzle/E-362_callback_loop.sql", "utf8");
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
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lead_callbacks'
       AND column_name IN ('kind', 'brief', 'reminded_at', 'neodove_pushed_at', 'escalated_at', 'push_attempts')
     ORDER BY column_name`;
  console.table(cols);
  if (cols.length !== 6) throw new Error(`expected 6 loop columns, found ${cols.length}`);
  const [ix] = await check`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'lead_callbacks_loop_due_idx'`;
  if (ix.n !== 1) throw new Error("lead_callbacks_loop_due_idx missing");
  console.log("E-362 verified: 6 columns + loop index on lead_callbacks");
} finally {
  await check.end();
}
