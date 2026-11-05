// One-off: apply E-375 (lead_callbacks.time_not_set — a callback with no time is
// flagged, not a silent 11:00; Priya KPI tracker task 11) to database-1
// (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e375.mjs database-1
//   node scripts/_apply-e375.mjs database-2
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e375.mjs database-1   (from a worktree)
//
// Additive: one column on an E-356 table, not mirrored in schema.ts. Reads that host's URL from
// .env.local (commented or not), never prints it. Applies the file twice (the second
// pass must be a no-op), then re-checks the tables and their columns on a FRESH
// connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-375_callback_time_not_set.sql", "utf8");
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
  const [col] = await check`
    SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lead_callbacks' AND column_name = 'time_not_set'`;
  if (!col || col.data_type !== "boolean" || col.is_nullable !== "NO") throw new Error(`time_not_set: ${JSON.stringify(col)}`);
  console.log("E-375 verified: lead_callbacks.time_not_set boolean not null default false");
} finally {
  await check.end();
}
