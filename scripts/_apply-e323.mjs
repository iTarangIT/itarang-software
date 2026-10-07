// One-off: apply E-323 (product list prices + dealer_lead_commercials.
// list_price_snapshot) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e323.mjs database-1
//   node scripts/_apply-e323.mjs database-2
//
// Prod had product_list_prices already (our E-321 creates the same table) but
// not list_price_snapshot, which schema.ts declares — so every Drizzle query on
// dealer_lead_commercials would fail there. Reads that host's URL from
// .env.local (commented or not), never prints it. Refuses to run if the
// partial unique index would fail on duplicate open rows. Applies the file
// twice (the second pass must be a no-op), then re-checks on a FRESH
// connection — DDL through unsafe() is not undone by a rollback.
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

const file = readFileSync("drizzle/E-323_product_list_prices.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const pre = postgres(url, opts);
try {
  const [t] = await pre`SELECT to_regclass('public.product_list_prices') IS NOT NULL AS ok`;
  const [i] = await pre`SELECT to_regclass('public.product_list_prices_open_from_uniq') IS NOT NULL AS ok`;
  if (t.ok && !i.ok) {
    const dups = await pre`
      SELECT asset_type, product_id, effective_from, count(*)::int AS n
        FROM product_list_prices WHERE effective_to IS NULL
       GROUP BY 1, 2, 3 HAVING count(*) > 1`;
    if (dups.length) {
      console.log("✗ duplicate open rows would break the unique index:", dups);
      process.exit(1);
    }
    console.log("✓ no duplicate open rows");
  }
} finally {
  await pre.end();
}

const sql = postgres(url, { ...opts, onnotice: () => {} });
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
  const [c] = await check`
    SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dealer_lead_commercials' AND column_name = 'list_price_snapshot'`;
  console.log(c ? `✓ dealer_lead_commercials.list_price_snapshot (${c.data_type})` : "✗ list_price_snapshot MISSING");
  const [n] = await check`SELECT count(*)::int AS n FROM product_list_prices`;
  console.log(`✓ product_list_prices (${n.n} rows)`);
  const idx = await check`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'product_list_prices'
       AND indexname IN ('product_list_prices_product_idx', 'product_list_prices_open_from_uniq')`;
  for (const name of ["product_list_prices_product_idx", "product_list_prices_open_from_uniq"]) {
    const r = idx.find((x) => x.indexname === name);
    console.log(r ? `✓ ${name}` : `✗ ${name} MISSING`);
  }
  const u = idx.find((x) => x.indexname === "product_list_prices_open_from_uniq");
  if (u) console.log(u.indexdef.includes("WHERE (effective_to IS NULL)") ? "✓ open-from index is partial" : "✗ open-from index not partial");
} finally {
  await check.end();
}
