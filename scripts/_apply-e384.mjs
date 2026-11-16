// One-off: apply E-384 (unique last-10-digit phone index on dealer_leads, ID 248; HELD on prod) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e384.mjs database-1
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e384.mjs database-1   (from a worktree)
//
// Index only. Does nothing while a number is still on two active leads (it says how many).
// Applies twice (the second pass must be a no-op), then checks the index on a
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
const file = readFileSync("drizzle/E-384_dealer_leads_phone_last10_unique.sql", "utf8");
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
  const [r] = await check`SELECT to_regclass('public.dealer_leads_phone_last10_uniq') IS NOT NULL AS ok`;
  console.log(r.ok ? "index dealer_leads_phone_last10_uniq: present" : "index dealer_leads_phone_last10_uniq: NOT created (see the notice above)");
} finally {
  await check.end();
}
