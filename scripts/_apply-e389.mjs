// One-off: apply E-389 (CIBIL review conditions + doc-request link) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e389.mjs database-1
//
// nbfc_cibil_reviews.conditions, nbfc_doc_requests.cibil_review_id + partial index.
// Reads that host's URL from the env file, never prints it. Applies twice (the second pass
// must be a no-op), then re-checks everything on a FRESH connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in the env file`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };
const file = readFileSync("drizzle/E-389_cibil_review_conditions_and_doc_link.sql", "utf8");
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
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'nbfc_cibil_reviews' AND column_name = 'conditions')
         OR (table_name = 'nbfc_doc_requests' AND column_name = 'cibil_review_id'))
     ORDER BY 1`;
  console.log("columns:", cols.map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`).join(", "));
  const [idx] = await check`SELECT to_regclass('public.nbfc_doc_requests_cibil_review_idx')::text AS i`;
  console.log("index:", idx.i);
  if (cols.length !== 2 || !idx.i) process.exitCode = 1;
} finally {
  await check.end();
}
