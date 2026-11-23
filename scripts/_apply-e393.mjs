// One-off: apply E-393 (LinkedIn Outreach tables) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e393.mjs database-1
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
const file = readFileSync("drizzle/E-393_linkedin_outreach.sql", "utf8");
const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const TABLES = [
  "li_provider_credentials",
  "li_accounts",
  "li_settings",
  "li_search_runs",
  "li_prospects",
  "li_search_results",
  "li_attachments",
  "li_campaigns",
  "li_approvals",
  "li_campaign_prospects",
  "li_conversations",
  "li_messages",
  "li_outbox",
  "li_action_log",
];
const INDEXES = [
  "li_prospects_profile_uniq",
  "li_prospects_url_uniq",
  "li_approvals_live_uniq",
  "li_campaign_prospects_one_live_uniq",
  "li_messages_provider_uniq",
  "li_action_log_caps_idx",
];

const check = postgres(url, opts);
try {
  const missing = [];
  for (const name of [...TABLES, ...INDEXES]) {
    const [r] = await check`SELECT to_regclass(${"public." + name})::text AS t`;
    if (!r.t) missing.push(name);
  }
  console.log(missing.length ? { missing } : `all ${TABLES.length} tables + ${INDEXES.length} indexes present`);
  if (missing.length) process.exitCode = 1;
} finally {
  await check.end();
}
