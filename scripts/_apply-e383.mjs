// One-off: apply E-383 (screen names in the dealer_leads.lead_status comment, ID 167) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e383.mjs database-1
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e383.mjs database-1   (from a worktree)
//
// Catalog comment only. Reads that host's URL from the env file, never prints it. Applies
// twice (the second pass must report "already applied"), then re-reads the comment on a
// FRESH connection.
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
const file = readFileSync("drizzle/E-383_analyst_status_words_comment.sql", "utf8");
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
    SELECT col_description('public.dealer_leads'::regclass, a.attnum) AS comment
      FROM pg_attribute a
     WHERE a.attrelid = 'public.dealer_leads'::regclass AND a.attname = 'lead_status'`;
  console.log("comment:", r?.comment ?? "(none)");
  if (!r?.comment?.includes("Quote given")) console.log("NOTE: comment does not name the screen words (hand-written comment kept?)");
} finally {
  await check.end();
}
