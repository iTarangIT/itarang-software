// One-off: apply E-331 (retire the "finance" business type → battery_sale) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e331.mjs database-1
//   node scripts/_apply-e331.mjs database-2
//
// Data-only migration. Reads that host's URL from .env.local (commented or
// not), never prints it. Prints the business_type breakdown before, applies the
// file twice (the second pass must update nothing), then re-reads the breakdown
// on a FRESH connection and fails if any 'finance' row is left.
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

const file = readFileSync("drizzle/E-331_business_type_finance_to_battery_sale.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const breakdown = async (db) =>
  Object.fromEntries(
    (await db`SELECT coalesce(business_type, '(null)') AS t, count(*)::int AS n
                FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`).map((r) => [r.t, r.n]),
  );

const pre = postgres(url, opts);
let before;
try {
  before = await breakdown(pre);
  console.log("before:", before);
} finally {
  await pre.end();
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
  const after = await breakdown(check);
  console.log("after: ", after);
  const expected = (before.battery_sale ?? 0) + (before.finance ?? 0);
  if (after.finance) throw new Error(`✗ ${after.finance} 'finance' rows remain`);
  if ((after.battery_sale ?? 0) !== expected)
    throw new Error(`✗ battery_sale = ${after.battery_sale}, expected ${expected}`);
  console.log(`✓ ${before.finance ?? 0} finance → battery_sale; no finance rows left`);
} finally {
  await check.end();
}
