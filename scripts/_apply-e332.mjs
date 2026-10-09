// One-off: apply E-332 (account_closures — ID 5 "Lost / closed dealer") to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e332.mjs database-1
//   node scripts/_apply-e332.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection that the table and its columns exist —
// postgres.js DDL is not undone by a rollback, so the check is a real one.
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

const file = readFileSync("drizzle/E-332_account_closures.sql", "utf8");
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
  const cols = (await check`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'account_closures' ORDER BY ordinal_position`).map((r) => r.column_name);
  console.log("account_closures columns:", cols.join(", "));
  for (const c of ["account_id", "reason", "closed_by", "closed_at"]) {
    if (!cols.includes(c)) throw new Error(`✗ column ${c} missing`);
  }
  console.log("✓ E-332 applied");
} finally {
  await check.end();
}
