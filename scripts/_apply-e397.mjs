// One-off: apply E-397 (Won payment reference) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e397.mjs database-1
//
// dealer_leads: + won_payment_reference text, + won_payment_recorded_at timestamptz. Reads
// that host's URL from the env file, never prints it. Applies twice (the second pass must
// be a no-op), then re-checks the columns on a FRESH connection.
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
const file = readFileSync("drizzle/E-397_won_payment_reference.sql", "utf8");
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
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dealer_leads'
       AND column_name IN ('won_payment_reference', 'won_payment_recorded_at') ORDER BY 1`;
  console.table(cols);
  const ok = cols.length === 2 && cols.every((c) => c.is_nullable === "YES");
  console.log(ok ? "E-397 verified" : "E-397 NOT as expected");
  if (!ok) process.exitCode = 1;
} finally {
  await check.end();
}
