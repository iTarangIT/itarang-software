// One-off: apply E-340 (Zoho copy read markers + refused GSTINs — IDs 70, 62)
// to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e340.mjs database-1
//   node scripts/_apply-e340.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then checks on a FRESH connection — postgres.js DDL is not undone by a
// rollback, so the check is a real one.
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

const file = readFileSync("drizzle/E-340_zoho_copy_markers_and_refused_gstins.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  const [pre] = await sql`SELECT to_regclass('public.zoho_customer_gstins') IS NOT NULL AS ok`;
  if (!pre.ok) throw new Error("E-322 is not applied here (zoho_customer_gstins missing)");
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  const [t] = await check`SELECT to_regclass('public.zoho_invoice_line_fetches') IS NOT NULL AS ok`;
  if (!t.ok) throw new Error("✗ zoho_invoice_line_fetches missing");
  const cols = await check`SELECT column_name FROM information_schema.columns
                            WHERE table_name = 'zoho_customer_gstins' AND column_name IN ('refused_gstin', 'refused_reason')`;
  if (cols.length !== 2) throw new Error("✗ refused_gstin / refused_reason missing");
  const [m] = await check`SELECT count(*)::int AS n FROM zoho_invoice_line_fetches`;
  console.log(`zoho_invoice_line_fetches rows: ${m.n} (invoices copied before E-340)`);
  console.log("✓ E-340 applied");
} finally {
  await check.end();
}
