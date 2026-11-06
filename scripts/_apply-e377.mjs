// One-off: apply E-377 (ID 214 — every onboarding on exactly one lead: six
// additive columns on dealer_onboarding_applications) to database-1 (sandbox)
// or database-2 (prod).
//
//   node scripts/_apply-e377.mjs database-1
//   node scripts/_apply-e377.mjs database-2
//
// Additive only. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies the file twice (the second pass must be a no-op),
// then re-checks the columns on a FRESH connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-377_onboarding_lead_match.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const WANT = [
  "lead_match_method",
  "lead_match_candidates",
  "lead_match_at",
  "lead_match_confirmed_at",
  "lead_match_confirmed_by",
  "lead_credit_user_id",
];
const check = postgres(url, opts);
try {
  const rows = await check`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'dealer_onboarding_applications' AND column_name IN ${check(WANT)}`;
  const have = new Set(rows.map((r) => r.column_name));
  const missing = WANT.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`missing columns: ${missing.join(", ")}`);
  console.log(`E-377 verified: dealer_onboarding_applications has all ${WANT.length} lead-match columns`);
} finally {
  await check.end();
}
