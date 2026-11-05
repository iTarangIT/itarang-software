// One-off: apply E-376 (inbound_calls — dealers ringing the Vobiz number,
// Priya KPI tracker task 9) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e376.mjs database-1
//   node scripts/_apply-e376.mjs database-2
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e376.mjs database-1   (from a worktree)
//
// Additive: one new table, not mirrored in schema.ts. Reads that host's URL from
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

const file = readFileSync("drizzle/E-376_inbound_calls.sql", "utf8");
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

const want = {
  inbound_calls: [
    "id", "call_sid", "conversation_id", "caller_phone", "phone_key", "lead_id", "callback_id", "branch",
    "answered", "return_due_at", "returned_at", "handled_at", "created_at", "updated_at",
  ],
};

const check = postgres(url, opts);
try {
  for (const [table, cols] of Object.entries(want)) {
    const got = (
      await check`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
         ORDER BY ordinal_position`
    ).map((c) => c.column_name);
    if (JSON.stringify(got) !== JSON.stringify(cols)) {
      throw new Error(`${table}: columns differ: ${got.join(", ")}`);
    }
    const [pk] = await check`
      SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relname = ${table} AND i.indisprimary`;
    if (pk.n !== 1) throw new Error(`${table}: primary key missing`);
    console.log(`${table}: ${cols.length} columns + primary key`);
  }
  console.log("E-376 verified");
} finally {
  await check.end();
}
