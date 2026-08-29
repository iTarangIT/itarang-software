// Applies drizzle/E-251_sandbox_to_prod_drift.sql — the sandbox→production
// structural gap found by `npm run db:drift` on 2026-08-18.
//
//   node scripts/apply-e251.mjs <env-file|->        # dry run: reports, writes nothing
//   node scripts/apply-e251.mjs <env-file|-> --apply
//
// TARGET SELECTION IS EXPLICIT AND MANDATORY. Every earlier applier in this
// series (apply-e237.mjs:25, apply-e238.mjs) defaults to reading .env.local, and
// **.env.local is SANDBOX (database-1)** — see drizzle/MIGRATION_CHECKLIST.md
// "Environments". That default is how a change intended for production silently
// lands on sandbox instead; it happened on 2026-08-18 and cost a round trip. So
// there is no default here: name the env file (`.env.production`, `.env.local`)
// or pass `-` to use process.env.DATABASE_URL. The resolved host AND which
// environment that host IS are printed before anything is written.
//
// This file is the intended route to production for E-237's three neodove
// columns as well — apply-e237.mjs cannot reach prod, because it hardcodes
// .env.local. See the E-251 header.
//
// Idempotent: re-running reports every statement as already-present. The two
// foreign keys are the only statements that can fail on DATA (an orphan row);
// they are guarded inside the SQL to skip with a NOTICE rather than abort.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const [target, ...flags] = process.argv.slice(2);
const APPLY = flags.includes("--apply");

if (!target) {
  console.error("usage: node scripts/apply-e251.mjs <env-file|-> [--apply]");
  console.error("   eg: node scripts/apply-e251.mjs .env.production          # dry run");
  console.error("       node scripts/apply-e251.mjs .env.production --apply");
  process.exit(1);
}

function resolveUrl() {
  if (target === "-") {
    if (!process.env.DATABASE_URL) throw new Error("'-' given but DATABASE_URL is not set in the environment.");
    return { url: process.env.DATABASE_URL, from: "process env" };
  }
  const m = readFileSync(target, "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error(`No active DATABASE_URL line in ${target}.`);
  return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: target };
}

const { url, from } = resolveUrl();
const ddl = readFileSync("drizzle/E-251_sandbox_to_prod_drift.sql", "utf8");

const host = new URL(url).hostname;
const envName = host.startsWith("database-2")
  ? "PRODUCTION  (crm.itarang.com)"
  : host.startsWith("database-1")
    ? "sandbox     (sandbox.itarang.com)"
    : "UNKNOWN — verify before continuing";

console.log(`HOST : ${host}   (from ${from})`);
console.log(`ENV  : ${envName}`);
console.log(`MODE : ${APPLY ? "APPLY (will write)" : "DRY RUN (reports only, writes nothing)"}\n`);

// (table, column) — null column means "the table itself".
const EXPECTED = [
  ["module_usage_user_daily", null],
  ["neodove_campaigns", "crm_owner_user_id"],
  ["neodove_lead_links", "assigned_owner_id"],
  ["neodove_lead_links", "assigned_at"],
];
const EXPECTED_INDEXES = [
  "module_usage_user_daily_day_idx",
  "module_usage_user_daily_module_idx",
  "module_usage_user_daily_user_idx",
  "neodove_lead_links_assigned_owner_idx",
  "inventory_upload_reports_dealer_idx",
  "inventory_upload_reports_uploaded_by_idx",
  "inventory_upload_reports_uploaded_at_idx",
];
const EXPECTED_FKS = ["nbfc_tenant_id_fkey", "field_investigations_agent_fk"];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 20 });

async function report(label) {
  console.log(`--- ${label} ---`);
  for (const [table, column] of EXPECTED) {
    if (column === null) {
      const [r] = await sql`SELECT to_regclass(${"public." + table}) AS t`;
      console.log(`  ${r.t ? "present" : "MISSING"}  table ${table}`);
    } else {
      const [r] = await sql`SELECT 1 AS ok FROM information_schema.columns
                             WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
      console.log(`  ${r ? "present" : "MISSING"}  ${table}.${column}`);
    }
  }
  const idx = (await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY(${EXPECTED_INDEXES})`)
    .map((r) => r.indexname);
  for (const i of EXPECTED_INDEXES) console.log(`  ${idx.includes(i) ? "present" : "MISSING"}  index ${i}`);
  const fks = (await sql`SELECT conname FROM pg_constraint WHERE conname = ANY(${EXPECTED_FKS})`).map((r) => r.conname);
  for (const f of EXPECTED_FKS) console.log(`  ${fks.includes(f) ? "present" : "MISSING"}  fk ${f}`);
  console.log("");
  return { idx, fks };
}

try {
  await report("BEFORE");

  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply to execute the migration.");
    process.exit(0);
  }

  // The FK orphan counts, checked against the target we are ABOUT to write to
  // rather than against the one they were measured on. A non-zero count is not
  // fatal (the SQL skips that constraint with a NOTICE) but it must be visible.
  for (const [label, q] of [
    ["nbfc.tenant_id -> nbfc_tenants", sql`SELECT count(*) FILTER (WHERE n.tenant_id IS NOT NULL AND t.id IS NULL)::int AS orphans
                                              FROM nbfc n LEFT JOIN nbfc_tenants t ON t.id = n.tenant_id`],
    ["field_investigations.assigned_agent_id -> nbfc_fi_agents", sql`SELECT count(*) FILTER (WHERE f.assigned_agent_id IS NOT NULL AND a.id IS NULL)::int AS orphans
                                              FROM field_investigations f LEFT JOIN nbfc_fi_agents a ON a.id = f.assigned_agent_id`],
  ]) {
    try {
      const [r] = await q;
      console.log(`orphan check  ${label}: ${r.orphans}`);
    } catch (err) {
      console.log(`orphan check  ${label}: skipped (${err.code || err.message})`);
    }
  }
  console.log("");

  console.log("applying E-251…");
  await sql.unsafe(ddl);
  console.log("applied.\n");

  const { idx, fks } = await report("AFTER");

  const missingIdx = EXPECTED_INDEXES.filter((i) => !idx.includes(i));
  const missingFks = EXPECTED_FKS.filter((f) => !fks.includes(f));
  if (missingIdx.length || missingFks.length) {
    console.log("NOT everything landed — check the NOTICEs above:");
    if (missingIdx.length) console.log("  indexes still missing:", missingIdx.join(", "));
    if (missingFks.length) console.log("  fks still missing:", missingFks.join(", "), "(orphan rows? see the SQL header)");
    process.exitCode = 1;
  } else {
    console.log("All E-251 objects present on this database.");
    console.log("Now tick BOTH E-251 and E-237 for this environment in drizzle/MIGRATION_CHECKLIST.md.");
  }
} finally {
  await sql.end();
}
