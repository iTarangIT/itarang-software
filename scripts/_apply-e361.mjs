// One-off: apply E-361 (dealer_lead_phone_type — mobiles-only, B1) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e361.mjs database-1
//   node scripts/_apply-e361.mjs database-2
//
// Additive: one new table, not mirrored in schema.ts. Reads that host's URL from
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

const file = readFileSync("drizzle/E-361_dealer_lead_phone_type.sql", "utf8");
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
     WHERE table_schema = 'public' AND table_name = 'dealer_lead_phone_type'
     ORDER BY ordinal_position`;
  const want = ["lead_id", "phone", "phone_type", "checked_at"];
  const got = cols.map((c) => c.column_name);
  console.table(cols);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`columns differ: ${got.join(", ")}`);
  const [pk] = await check`
    SELECT count(*)::int AS n FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
     WHERE c.relname = 'dealer_lead_phone_type' AND i.indisprimary`;
  if (pk.n !== 1) throw new Error("primary key missing");
  console.log("E-361 verified: table, 4 columns, primary key");
} finally {
  await check.end();
}
