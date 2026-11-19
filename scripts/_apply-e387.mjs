// One-off: apply E-387 (NBFC parent/child CIBIL approval hierarchy) to database-1
// (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e387.mjs database-1
//
// Two columns on nbfc_users, one on nbfc_tenants, new table nbfc_cibil_reviews + 3 indexes.
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
const file = readFileSync("drizzle/E-387_nbfc_cibil_approval_hierarchy.sql", "utf8");
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
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'nbfc_users' AND column_name IN ('parent_user_id', 'delegated_steps'))
         OR (table_name = 'nbfc_tenants' AND column_name = 'cibil_review_enabled_at'))
     ORDER BY 1, 2`;
  const tbl = await check`SELECT to_regclass('public.nbfc_cibil_reviews') AS t`;
  const idx = await check`
    SELECT indexname FROM pg_indexes
     WHERE indexname IN ('nbfc_cibil_reviews_lead_idx', 'nbfc_cibil_reviews_approver_idx', 'nbfc_cibil_reviews_one_pending_uniq')
     ORDER BY 1`;
  console.log("columns:", cols.map((c) => `${c.table_name}.${c.column_name}`).join(", "));
  console.log("table:", tbl[0].t ?? "MISSING");
  console.log("indexes:", idx.map((i) => i.indexname).join(", "));
  if (cols.length !== 3 || !tbl[0].t || idx.length !== 3) process.exitCode = 1;
} finally {
  await check.end();
}
