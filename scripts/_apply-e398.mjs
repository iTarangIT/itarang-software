// One-off: apply E-398 (LinkedIn campaign categories + meetings) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e398.mjs database-1
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
const file = readFileSync("drizzle/E-398_linkedin_categories_meetings.sql", "utf8");
const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

// E-393 must already be there (the code joins these to li_campaigns etc.).
const TABLES = ["li_campaigns", "li_campaign_prospects", "li_campaign_categories", "li_meetings", "li_meeting_hints"];
const INDEXES = ["li_campaign_categories_cat_idx", "li_meetings_marked_idx"];

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
