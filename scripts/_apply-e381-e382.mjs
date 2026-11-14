// One-off: apply E-381 (analyst_threads — the AI Analyst conversation list) and E-382
// (analyst_verified_queries — verified SQL) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e381-e382.mjs database-1
//   node scripts/_apply-e381-e382.mjs database-2
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e381-e382.mjs database-1   (from a worktree)
//
// Additive: two new tables, not mirrored in schema.ts. Reads that host's URL from
// .env.local (commented or not), never prints it. Applies each file twice (the second
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

const files = ["drizzle/E-381_analyst_threads.sql", "drizzle/E-382_analyst_verified_queries.sql"];
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const path of files) {
    const file = readFileSync(path, "utf8");
    for (const pass of [1, 2]) {
      await sql.begin((tx) => tx.unsafe(file));
      console.log(`${path} pass ${pass}: ok`);
    }
  }
} finally {
  await sql.end();
}

const want = {
  analyst_threads: [
    "thread_id", "user_id", "title", "title_custom", "first_question", "questions", "connection_id",
    "run_count", "last_asked_at", "pinned_at", "archived_at", "deleted_at", "share_token", "shared_at",
    "created_at", "updated_at",
  ],
  analyst_verified_queries: [
    "id", "connection_id", "question", "question_norm", "sql", "sql_norm", "source_run_id",
    "verified_by", "verified_at", "note", "active", "created_at", "updated_at",
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
  console.log("E-381 + E-382 verified");
} finally {
  await check.end();
}
