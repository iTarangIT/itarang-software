// One-off: apply E-394 (Battery Pool workflow, renumbered from E-393, 23 Nov 2026) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e394.mjs database-1
//
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
const file = readFileSync("drizzle/E-394_battery_pool_workflow_23nov.sql", "utf8");
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
  const [r] = await check`
    SELECT to_regclass('public.lead_scheme_picks')::text AS scheme_picks,
           to_regclass('public.lead_resumes')::text AS resumes,
           to_regclass('public.lead_resumes_old_lead_idx')::text AS resumes_idx,
           (SELECT count(*)::int FROM information_schema.columns
             WHERE table_name = 'nbfc_cibil_reviews' AND column_name = 'condition_docs') AS condition_docs`;
  console.log(r);
  if (!r.scheme_picks || !r.resumes || !r.resumes_idx || r.condition_docs !== 1) process.exitCode = 1;
} finally {
  await check.end();
}
