// One-off: apply E-321 (account ownership + list price) to database-1
// (sandbox) or database-2 (prod). Tracker P1 IDs 4, 5, 67, 68, 69.
//
//   node scripts/_apply-e321.mjs database-1
//   node scripts/_apply-e321.mjs database-2
//
// Reads that host's URL from .env.local (commented or not), never prints it.
// Applies the file twice (the second pass must be a no-op), then re-checks
// the tables on a FRESH connection — DDL through unsafe() is not undone by a
// rollback, so a "rolled back" dry run proves nothing; this script has none.
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

const file = readFileSync("drizzle/E-321_account_ownership_list_price.sql", "utf8");
const TABLES = [
  "account_ownership",
  "account_owner_history",
  "account_gstins",
  "invoice_account_links",
  "product_list_prices",
];

const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false }, onnotice: () => {} });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });
try {
  for (const t of TABLES) {
    const [r] = await check`SELECT to_regclass(${"public." + t}) IS NOT NULL AS ok`;
    const [c] = r.ok ? await check.unsafe(`SELECT count(*)::int AS n FROM ${t}`) : [{ n: null }];
    console.log(`${r.ok ? "✓" : "✗"} ${t}${r.ok ? ` (${c.n} rows)` : " MISSING"}`);
  }
  const idx = await check`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'account_owner_history' AND indexname = 'account_owner_history_open_uniq'`;
  console.log(idx[0]?.indexdef?.includes("WHERE (effective_to IS NULL)") ? "✓ open-window index is partial" : "✗ open-window index wrong");
} finally {
  await check.end();
}
