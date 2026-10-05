// One-off: apply E-322 (quote terms, invoice lines, voids, credit notes, GSTR-1) to database-1
// (sandbox) or database-2 (prod). Tracker P1 IDs 39, 70, 71, 73.
//
//   node scripts/_apply-e322.mjs database-1
//   node scripts/_apply-e322.mjs database-2
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

const file = readFileSync("drizzle/E-322_quote_terms_invoice_lines_voids.sql", "utf8");
const TABLES = [
  "invoice_line_items",
  "zoho_customer_gstins",
  "vyapar_item_map",
  "invoice_imports",
  "invoice_voids",
  "credit_notes",
  "gstr1_entries",
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
  const cols = await check`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE (table_name = 'dealer_lead_commercials' AND column_name IN ('dealer_payment_terms','credit_days','customer_finance'))
        OR (table_name = 'sales_invoice_folders' AND column_name = 'doc_kind')`;
  console.log(cols.length === 4 ? "✓ 4 new columns present" : `✗ new columns: ${cols.map((c) => c.column_name).join(", ")}`);
  const idx = await check`SELECT indexdef FROM pg_indexes WHERE indexname = 'credit_notes_number_key_uniq'`;
  console.log(idx[0]?.indexdef?.includes("WHERE (note_number_key IS NOT NULL)") ? "✓ credit note index is partial" : "✗ credit note index wrong");
} finally {
  await check.end();
}
